import "server-only";
import {
  formatIncidentClock,
  type IncidentTimeline,
  type IncidentTimelineEntry,
  type IncidentTimelineKind,
  type IncidentTimelineLeg,
  type IncidentTimelineOmission,
  type IncidentTimelineRow,
} from "@/lib/incident-types";
import { listAlertEventsInWindow } from "@/server/alerts";
import { listChangeEventsInLeadIn, listChangeEventsInWindow } from "@/server/changes";
import type { AlertEventRow } from "@/lib/alert-types";
import type { ChangeEventRow } from "@/lib/change-types";
import type { ScopedClickHouse } from "@/server/clickhouse";
import type { QueryRows } from "@/server/postgres";
import { queryIncidentErrors, type IncidentErrorRow } from "@/server/queries/incident-errors";

/**
 * The incident timeline's STITCHER (S7.4 packet D530, D534–D540).
 *
 * Three reads across two stores, merged into one ordered list, plus the three
 * states in which the list is allowed to be shorter than the truth.
 *
 * ---- why this module exists at all ----
 *
 * It is deliberately NOT in `server/incidents.ts`: that module is the incident
 * CRUD store, and putting the stitch there would put a `ScopedClickHouse`
 * import on it — a Postgres store that transitively needs a telemetry client to
 * be constructed. And it is deliberately NOT inline in
 * `app/app/incidents/[id]/page.tsx`: the sort key, the tie-break, the lead-in
 * band, the retention clip and the per-leg caps would then have no unit test
 * except through a page render, and this repo has no DOM harness (D54(iii)).
 *
 * It holds NO store of its own — `query` and `ch` are both handed in (D113) —
 * so every test below runs with no Postgres and no ClickHouse present.
 *
 * ---- ONE CLOCK, sampled once (D534) ----
 *
 * `Date.now()` appears EXACTLY ONCE in this file, and every bound the three
 * legs receive is derived from that one sample. Never a second `Date.now()` and
 * never a `now()` inside any of the three statements: three legs across two
 * stores would otherwise be three clocks on two machines, and a change event
 * could sort after the trace error it actually preceded. For an ONGOING
 * incident that one sample IS the window's exclusive end.
 *
 * ---- CLIP THE INPUT (D540) ----
 *
 * `effectiveStart = max(startedAt, now − retentionDays × 86_400_000)`. Clipping
 * the INPUT rather than filtering the output is what makes the honesty
 * structural: the SQL is never asked for rows the retention sweeper deleted, so
 * an empty leg can only mean nothing happened. A filter over the output would
 * be indistinguishable from a quiet window, and would ALSO be a second place
 * where the floor is computed.
 *
 * The three render states this module hands the surface:
 *
 *   clean            `windowStartIso === the incident's own startedAt`
 *   clipped          `windowStartIso > startedAt` — the surface renders the
 *                    SHIPPED D507 register `· ${retentionDays}d retained on
 *                    ${planName}` (`SlosLive.tsx:83,109`) whether or not rows
 *                    came back, and NEVER names a date and NEVER says evidence
 *                    was deleted: the sweeper is a 24h ticker that over-retains
 *                    on failure, so a dated claim would print above a row it
 *                    says is gone, and the date would be typed rather than
 *                    computed (the S7.3 lesson).
 *   outsideRetention the whole window predates the floor — ZERO reads are
 *                    issued and the surface says the window is older than what
 *                    the plan retains. A bound on the READ, never a claim about
 *                    a deletion the product never observed, which is why the
 *                    field is named `outsideRetention` and not `fullySwept`.
 *
 * This module authors NO sentence about any of that. It returns
 * `retentionDays`, `planName` and the two window instants as DATA; the words
 * are the surface's, in one place, from the shipped register.
 *
 * ---- LOCATABLE truncation (D536) ----
 *
 * Each leg is read `LIMIT cap + 1` and the probe row gives `omittedAfterIso`
 * free — the `at` of the last row the cap KEPT. `omissions` is per-leg because
 * a single boolean cannot say that a leg went dark mid-incident, and a hole
 * would then render as absence of activity, which is D13's "a gap is never a
 * zero" inverted. There is no merged post-sort cap: a second cap would delete
 * evidence a leg already paid to read and would make truncation mean two
 * things.
 *
 * ---- the total order (D538) ----
 *
 * `(at ASC, sourceRank ASC, key ASC)`. `sourceRank` exists because the tie
 * order must be a STATED RULE rather than an artefact of which array was
 * concatenated first. It is NOT there because `Array.prototype.sort` is
 * unstable — it has been stable since ES2019 — and the proof in the test is not
 * a flakiness probe: it is the same set fed in a DIFFERENT concat order,
 * asserted to render the identical sequence.
 */

// ---- the constants -----------------------------------------------------------

/** D536, the house's capped-analytic-list number. Applied PER LEG. */
export const TIMELINE_LEG_CAP = 50;

/** D535: how far before `started_at` the changes band reaches. */
export const CHANGE_LEAD_IN_MS = 3_600_000;

/**
 * D535's cap for the lead-in band, which the packet names but never values.
 * TWENTY, for two reasons that are checkable rather than aesthetic: the sibling
 * tests written with the read itself already pin the shape at `cap + 1 = 21`
 * (`changes.test.ts:56`, `changes.integration.test.ts:195`), and the band is
 * CONTEXT rather than the story — at 50 a full band would equal the whole
 * in-window budget, which is D535's own defect ("the lead-in eats the cap")
 * reappearing inside the render after being fixed in the read.
 * ⟨S7.4 T4 plan correction: recorded as a gap the packet left, not a choice it
 * made.⟩
 */
export const CHANGE_LEAD_IN_CAP = 20;

/**
 * D538 verbatim. A change is rank 0 because a change that shares an instant
 * with an alert is the thing the alert is about; `resolved` is 3 because it is
 * synthesized at the window's exclusive end and nothing read can follow it.
 */
export const TIMELINE_SOURCE_RANK: Record<IncidentTimelineKind, number> = {
  change: 0,
  alert: 1,
  trace: 2,
  resolved: 3,
};

const DAY_MS = 86_400_000;

// ---- the input ----------------------------------------------------------------

/**
 * The incident's own window, structurally satisfied by an `IncidentRow` — the
 * page passes the row it already read (D539's two serialised round trips), and
 * this module needs no other column, so it asks for none. `endedAt === null`
 * means ongoing, and then the window's end is the one sampled clock.
 */
export interface IncidentTimelineWindow {
  startedAt: string;
  endedAt: string | null;
}

/**
 * The shipped `IncidentTimeline` plus the ONE instant it cannot express.
 *
 * ⟨S7.4 T4 PLAN CORRECTION — a defect in the shipped contract, not a widening
 * for convenience. `lib/incident-types.ts:191-193` says the D507 register is
 * rendered "whenever the read's input was clipped", and D540 names THREE render
 * states — but the interface carries only `outsideRetention`, so a surface
 * holding an `IncidentTimeline` cannot tell the clipped state from the clean
 * one. It cannot recompute it either: the floor needs `now`, and for a RESOLVED
 * incident `windowEndIso` is `ended_at` rather than the clock, so any caller
 * deriving it would sample a SECOND clock — the exact defect D534 forbids. T5
 * has the same need with a second consequence: D554's `IncidentSubject.startedAt`
 * is documented as "already clipped to the plan's retention floor", and the RCA
 * route can only get that instant from here.
 *
 * ONE field answers both, and it is the symmetric partner of the shipped
 * `windowEndIso`, so the pair states exactly the half-open interval the three
 * legs were asked for. `clipped` is then `windowStartIso !== incident.startedAt`
 * and needs no second boolean. It is declared here rather than in
 * `lib/incident-types.ts` because that file is not this task's to edit; the
 * correction to make is to move this one line into `IncidentTimeline` and
 * delete this interface.⟩
 */
export interface StitchedIncidentTimeline extends IncidentTimeline {
  /** ISO UTC, INCLUSIVE start of the half-open window actually read — the
   *  incident's own `startedAt`, or the retention floor when that is later. */
  windowStartIso: string;
  /** TRUE when the retention floor raised EITHER the window's start or the
   *  changes band's (D574). The surface renders the D507 register off THIS and
   *  never derives it from `windowStartIso !== startedAt`, which is blind to a
   *  floor that lands inside the band, and never recomputes the floor itself,
   *  which would need a second clock (D534). */
  inputClipped: boolean;
  /**
   * The RCA's rows (D554's seven fields), projected from the SAME capped legs
   * the entries came from — so the prompt and the page read one set.
   *
   * ⟨S7.4 D577, closed here: `IncidentTimelineEntry` carries neither
   * `severity` nor `service`, and the RCA route was rebuilding rows FROM the
   * entries, so every alert reached the model with `severity: null` and every
   * change with `service: null` — the model could not tell a critical alert
   * from a warning. The reads that HAD those columns (`AlertEventRow.severity`,
   * `ChangeEventRow.service`) are these legs; projecting here is the only place
   * that needs no second read and no second clock (D534).⟩
   *
   * The band's rows are included (they are context the prompt names as such),
   * and the synthesized `resolved` row is not — it is a column, not evidence.
   */
  rows: IncidentTimelineRow[];
}

// ---- the merge ----------------------------------------------------------------

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * D538's total order, exported so the rule can be proven under a different
 * concat order rather than asserted about the stitcher's own array literal.
 *
 * The comparison on `at` is plain code-unit order and not `Date.parse`: every
 * leg emits a fixed-width `toISOString()`, so the string IS the instant order,
 * and re-parsing 150 strings to compare them would be work that buys nothing.
 */
export function sortTimelineEntries(entries: readonly IncidentTimelineEntry[]): IncidentTimelineEntry[] {
  return [...entries].sort(
    (a, b) =>
      cmp(a.at, b.at) || TIMELINE_SOURCE_RANK[a.kind] - TIMELINE_SOURCE_RANK[b.kind] || cmp(a.key, b.key),
  );
}

// ---- the four entry shapes ----------------------------------------------------

/**
 * An alert event. `link` is a PRODUCT-INTERNAL deep link (`alert_events.link`
 * is written by the Go deliverer as an app path, and `AlertsLive.tsx:103-107`
 * renders it with `<Link>`), so `external` is false and the label is the same
 * "view evidence" that surface already uses — one wording for one link.
 *
 * The severity and the producing rule/SLO are deliberately NOT composed into
 * the detail: `IncidentTimelineEntry` has no field for either, `IncidentTimelineRow`
 * (the RCA shape, D554) has both as separate fields, and a `critical · …`
 * prefix authored here would be a vocabulary the surface can neither style nor
 * test. The row's own `detail` is the store's, verbatim.
 */
const alertEntry = (row: AlertEventRow): IncidentTimelineEntry => ({
  kind: "alert",
  at: row.at,
  until: null,
  title: row.title,
  detail: row.detail,
  link: row.link === null ? null : { label: "view evidence", href: row.link, external: false },
  key: row.id,
});

/**
 * A change event. `external` is TRUE: the link is the customer's own source
 * system (D499 refuses anything but an absolute http(s) URL), and
 * `changes/page.test.ts:104-107` pins that it renders as
 * `<a target="_blank" rel="noopener noreferrer">` and NEVER as a
 * product-internal `<Link>`. That is why `external` is a FIELD and not a branch
 * on `kind` (D538) — the same entry type carries both shapes.
 *
 * The six `ChangeKind`s collapse to one `change` row and the kind is NOT
 * written into the words (D537): the surface never authors "k8s".
 */
const changeEntry = (row: ChangeEventRow): IncidentTimelineEntry => ({
  kind: "change",
  at: row.at,
  until: null,
  title: row.title,
  detail: row.detail,
  link: row.link === null ? null : { label: row.link.label, href: row.link.href, external: true },
  key: row.id,
});

/**
 * One `(service, span name)` error group (D532).
 *
 * The TITLE names the span and the COUNT rides the detail WITH its span: a
 * title reading "2 errors on POST /chat" drawn at 13:04 states a number not
 * reached until 13:19. Both instants go through the shipped
 * `formatIncidentClock`, so no clock is hand-rolled here and the seconds that
 * make intra-minute ordering readable are present. When the group's first and
 * last error share an instant the arrow is dropped rather than printing
 * `X → X`.
 *
 * "grouped by service and span" is D532's stated disagreement with
 * `/app/issues`, which groups on the normalized message as well: the two
 * surfaces will show different counts for the same window, and that is said
 * rather than hidden.
 *
 * `key` is synthesized because the group has no row id, and it is
 * `encodeURIComponent`d so it holds no whitespace — it is also the detail rail's
 * anchor id. NOT `example_trace_id`: two groups (one trace erroring in two
 * services) can legally share one, and a duplicate key is a duplicate DOM id
 * and an unstable third sort key.
 *
 * The empty-trace guard is belt to the SQL's braces: `trace_id != ''` already
 * makes `argMin` unable to return `''`, and an unguarded `/app/traces/` + `''`
 * is the traces LIST — a reader clicking "example trace" mid-incident would
 * land on every trace in the workspace, none of which errored.
 */
function traceEntry(row: IncidentErrorRow): IncidentTimelineEntry {
  const at = new Date(row.first_seen_epoch_s * 1000).toISOString();
  const until = new Date(row.last_seen_epoch_s * 1000).toISOString();
  const span = at === until ? formatIncidentClock(at) : `${formatIncidentClock(at)} → ${formatIncidentClock(until)}`;
  return {
    kind: "trace",
    at,
    until,
    title: `${row.span_name} on ${row.service}`,
    detail: `${row.errors} error${row.errors === 1 ? "" : "s"}, ${span} · grouped by service and span`,
    link:
      row.example_trace_id === ""
        ? null
        : {
            label: "example trace",
            href: `/app/traces/${encodeURIComponent(row.example_trace_id)}`,
            external: false,
          },
    key: `trace:${encodeURIComponent(row.service)}:${encodeURIComponent(row.span_name)}`,
  };
}

/**
 * The fourth kind, synthesized from the incident's OWN `ended_at` (D537) — no
 * leg reads for it, so it can never be truncated. It sits AT the window's
 * exclusive upper bound, which is the one instant no read may return: the row
 * that closes the list is the only thing there, and it is not evidence, it is
 * the column.
 *
 * The row claims nothing beyond that column, so its detail is empty and it
 * carries no link; `key` is the constant because there is exactly one.
 */
const resolvedEntry = (atIso: string): IncidentTimelineEntry => ({
  kind: "resolved",
  at: atIso,
  until: null,
  title: "resolved",
  detail: "",
  link: null,
  key: "resolved",
});

// ---- the stitch ---------------------------------------------------------------

function instantOrThrow(value: string, field: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    // Loud rather than quiet: an unreadable instant would otherwise reach
    // `new Date(NaN).toISOString()` (a RangeError with no subject) or, worse,
    // bind `"Invalid Date"` into three statements and render whatever came
    // back as this incident's evidence.
    throw new Error(`readIncidentTimeline: ${field} is not a readable instant (${JSON.stringify(value)})`);
  }
  return ms;
}

/**
 * The whole read (D539). Called from `app/app/incidents/[id]/page.tsx` and
 * nowhere else, AFTER the incident row exists — a bogus or foreign id costs
 * exactly the `getIncident` statement and zero telemetry (D440).
 *
 * `planName` is a parameter and not read from anywhere: D539's quoted argument
 * list omits it, but `IncidentTimeline.planName` is a shipped field and D540's
 * clipped register is `· ${retentionDays}d retained on ${planName}` — so the
 * signature the packet quoted cannot produce the object the packet specifies.
 * ⟨S7.4 T4 plan correction: the argument list is six, not five.⟩ Both values
 * come from the `getUsage` row the page has already awaited.
 */
export async function readIncidentTimeline(
  workspaceId: string,
  window: IncidentTimelineWindow,
  retentionDays: number,
  planName: string,
  ch: ScopedClickHouse,
  query: QueryRows,
): Promise<StitchedIncidentTimeline> {
  // ---- THE clock. One sample, and every bound below is derived from it. ----
  const nowMs = Date.now();

  const startedAtMs = instantOrThrow(window.startedAt, "startedAt");
  const windowEndMs = window.endedAt === null ? nowMs : instantOrThrow(window.endedAt, "endedAt");
  const floorMs = nowMs - retentionDays * DAY_MS;
  const effectiveStartMs = Math.max(startedAtMs, floorMs);

  const windowStartIso = new Date(effectiveStartMs).toISOString();
  const windowEndIso = new Date(windowEndMs).toISOString();

  // Synthesized, never read — so it survives every retention state.
  const resolved = window.endedAt === null ? [] : [resolvedEntry(windowEndIso)];
  const base = { retentionDays, planName, windowStartIso, windowEndIso };

  // ---- state three: the whole window predates the floor. ZERO reads. ----
  //
  // ⟨S7.4 T4 plan correction, D571: this guard was `effectiveStartMs >=
  // windowEndMs`, which is true of THREE different situations and only one of
  // them is retention. D540 words this state as "this window is older than the
  // {n} days {plan} retains" — a claim about the plan's floor — so it is earned
  // ONLY by the floor. Both other cases were reproduced against the live stores:
  //
  //   (a) a ZERO-WIDTH incident. `0013_incidents.sql` CHECKs `ended_at IS NULL
  //       OR ended_at >= started_at` — note `>=` — so `ended_at = started_at` is
  //       a legal row, and one that ended an hour ago was being told its window
  //       predates a 7-day floor.
  //   (b) a FUTURE-STARTED ongoing incident. `server/incidents.ts` allows
  //       `started_at` up to INSTANT_SKEW_MS ahead of the server clock (D527),
  //       so an operator whose laptop is two minutes fast opened a window whose
  //       END precedes its START — rendered under a retention sentence.
  //
  // Both are the D13 failure the `outsideRetention` rename was made to prevent:
  // a claim about a past state the product never observed. A non-positive window
  // also issues zero reads, but it is NOT outside retention and must not say so.⟩
  const outsideRetention = floorMs >= windowEndMs;
  if (outsideRetention || effectiveStartMs >= windowEndMs) {
    return {
      ...base,
      // On a non-positive window the pair would otherwise run BACKWARDS: for a
      // future-started ongoing incident the end is the clock, which precedes
      // the start. Both bounds become the incident's OWN start, so the window
      // reads as zero-width — which is the truth, nothing has elapsed in it —
      // rather than as an interval running from later to earlier.
      windowStartIso: outsideRetention ? windowStartIso : new Date(startedAtMs).toISOString(),
      windowEndIso: outsideRetention ? windowEndIso : new Date(Math.max(startedAtMs, windowEndMs)).toISOString(),
      entries: resolved,
      rows: [],
      omissions: [],
      outsideRetention,
      inputClipped: outsideRetention,
    };
  }

  // The lead-in band is the CHANGES leg's alone (D535). Extending it to alerts
  // or error spans would put the PRECEDING incident's evidence on this
  // incident's timeline — a fabricated causal story, not context. It is clipped
  // by the same floor, and skipped entirely when the floor has swallowed it
  // (which is always the case once the incident's own start was clipped).
  //
  // The band is clipped against `floorMs` and NOT against `effectiveStartMs`.
  // Whenever nothing was clipped, `effectiveStartMs` IS `startedAtMs`, so
  // `max(startedAtMs - CHANGE_LEAD_IN_MS, effectiveStartMs)` collapses to
  // `startedAtMs` and the band has zero width — on every unclipped incident,
  // which is nearly all of them. Written the wrong way first and caught by this
  // file's own lead-in and merge tests, which reported it as six failures with
  // one cause.
  const leadInFromMs = Math.max(startedAtMs - CHANGE_LEAD_IN_MS, floorMs);
  // ⟨S7.4 T4 plan correction, D574: the band is clipped by the SAME floor, and
  // that was reported nowhere. The surface derives the D507 register from
  // `windowStartIso !== startedAt`, so an incident that starts INSIDE the
  // retention floor's last hour — the floor lands in the band, not in the
  // window — read ten minutes of a sixty-minute band and rendered no clip note
  // at all. Not an exotic input: it is every incident opened within an hour of
  // the plan's retention edge. `inputClipped` is the honest signal, and it is
  // reported rather than derived so the surface never recomputes a floor (which
  // would need a second clock — the defect D534 forbids).⟩
  const leadInClipped = floorMs > startedAtMs - CHANGE_LEAD_IN_MS;
  const leadInWanted = leadInFromMs < startedAtMs;

  const [alertRows, changeRows, leadInRows, errorRows] = await Promise.all([
    listAlertEventsInWindow(workspaceId, windowStartIso, windowEndIso, TIMELINE_LEG_CAP + 1, query),
    listChangeEventsInWindow(workspaceId, windowStartIso, windowEndIso, TIMELINE_LEG_CAP + 1, query),
    leadInWanted
      ? listChangeEventsInLeadIn(
          workspaceId,
          new Date(leadInFromMs).toISOString(),
          new Date(startedAtMs).toISOString(),
          CHANGE_LEAD_IN_CAP + 1,
          query,
        )
      : Promise.resolve<ChangeEventRow[]>([]),
    // ⟨S7.4 T4 plan correction, D572: this leg used to floor both bounds to
    // whole SECONDS, and that was live-proven to draw the wrong rows. Two
    // failures, both measured against a seeded ClickHouse: an error span 500 ms
    // BEFORE the window rendered as the incident's first row; and a span 300 ms
    // inside incident A was shown by its neighbour B, drawn 700 ms before B's
    // own stated start — one span, two incidents, wrong on each. Flooring also
    // asked below the retention floor by up to 999 ms, against D540's claim
    // that the SQL is never asked for rows the sweeper deleted.
    //
    // `start_time` is `DateTime64(9,'UTC')`, so the millisecond bound IS
    // expressible: `fromUnixTimestamp64Milli` is the house form `traces.ts`
    // already binds. The bounds now match the two Postgres legs exactly, so
    // all three legs and the window the surface prints are one interval.⟩
    queryIncidentErrors(ch, {
      sinceMs: effectiveStartMs,
      untilMs: windowEndMs,
      fetch: TIMELINE_LEG_CAP + 1,
    }),
  ]);

  // ---- the caps, and the probe row that locates each truncation (D536) ----
  const omissions: IncidentTimelineOmission[] = [];
  function capLeg<Row>(rows: Row[], leg: IncidentTimelineLeg, atOf: (row: Row) => string): Row[] {
    if (rows.length <= TIMELINE_LEG_CAP) return rows;
    const kept = rows.slice(0, TIMELINE_LEG_CAP);
    omissions.push({ leg, omittedAfterIso: atOf(kept[kept.length - 1]) });
    return kept;
  }

  const alerts = capLeg(alertRows, "alert", (row) => row.at);
  const changes = capLeg(changeRows, "change", (row) => row.at);
  const errors = capLeg(errorRows, "trace", (row) => new Date(row.first_seen_epoch_s * 1000).toISOString());

  // The band arrives NEWEST first (the SQL's `at DESC` is what makes its cap
  // keep the changes nearest the incident), so the probe row is the LAST
  // element. It is REPORTED, not discarded (D573): the band caps in descending
  // order, so its dropped rows are the EARLIEST ones and the instant to state is
  // the earliest row KEPT — `omittedBeforeIso`, with `band: true` so the surface
  // cannot read it as a gap inside the window.
  //
    // ⟨S7.4 T4 plan correction, D535 × D536, now DISCHARGED by D573. As first written the band contributed NO `omissions`
  // entry, and cannot. `omittedAfterIso` is defined as "the `at` of the last row
  // the cap KEPT", which reads as "rows AFTER this instant are not shown" — true
  // only of a leg capped in ASCENDING order. The band's dropped rows are the
  // EARLIEST ones, so an entry from it would state the exact opposite of the
  // truth, and both halves of the changes leg report under the same `leg:
  // "change"` so the surface could not tell them apart. The band is therefore
  // read as "the {CHANGE_LEAD_IN_CAP} changes nearest the start, in the hour
  // before" — which OBLIGES the surface to label it as that band rather than as
  // the hour's changes. That second field (`omittedBeforeIso`, plus a `band` marker) is now on the
  // contract, so the band reports its own truncation in its own direction.⟩
  const leadIn = leadInRows.slice(0, CHANGE_LEAD_IN_CAP).reverse();
  if (leadInRows.length > CHANGE_LEAD_IN_CAP && leadIn.length > 0) {
    omissions.push({ leg: "change", band: true, omittedBeforeIso: leadIn[0].at });
  }

  const entries = sortTimelineEntries([
    ...leadIn.map(changeEntry),
    ...changes.map(changeEntry),
    ...alerts.map(alertEntry),
    ...errors.map(traceEntry),
    ...resolved,
  ]);

  // D577: the RCA rows, from the same capped legs, with the two fields the
  // entries deliberately do not carry. Ordered like the entries so the prompt's
  // lanes read in the same order the page does.
  const rows: IncidentTimelineRow[] = [
    ...[...leadIn, ...changes].map(
      (row): IncidentTimelineRow => ({
        kind: "change",
        id: row.id,
        at: row.at,
        title: row.title,
        detail: row.detail,
        service: row.service,
        severity: null,
      }),
    ),
    ...alerts.map(
      (row): IncidentTimelineRow => ({
        kind: "alert",
        id: row.id,
        at: row.at,
        title: row.title,
        detail: row.detail,
        service: null,
        severity: row.severity,
      }),
    ),
    ...errors.map(
      (row): IncidentTimelineRow => ({
        kind: "trace",
        id: row.example_trace_id === "" ? null : row.example_trace_id,
        at: new Date(row.first_seen_epoch_s * 1000).toISOString(),
        title: `${row.span_name} on ${row.service}`,
        detail: `${row.errors} error${row.errors === 1 ? "" : "s"} · grouped by service and span`,
        service: row.service,
        severity: null,
      }),
    ),
  ].sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));

  return {
    ...base,
    entries,
    rows,
    omissions,
    outsideRetention: false,
    // TRUE when the floor raised EITHER the window's start or the band's — the
    // surface renders the D507 register off this and never recomputes a floor.
    inputClipped: effectiveStartMs > startedAtMs || leadInClipped,
  };
}

/*
 * ---- the second-rounding seam, CLOSED (D572) ---------------------------------
 *
 * This module used to floor both trace-leg bounds to whole seconds, on the
 * reasoning that `{since_s:UInt32}` could not express a millisecond and that
 * flooring BOTH ends at least kept adjacent incidents a partition of the second
 * axis. The partition argument was sound; the conclusion was not, because the
 * partition it preserved was of FLOORED SECONDS and not of the windows the
 * product prints. Two failures were measured against a seeded ClickHouse:
 *
 *   - an error span 500 ms BEFORE the incident's start rendered as the
 *     incident's first row, while the two Postgres legs (exact to the
 *     millisecond) correctly excluded rows in the same 500 ms; and
 *   - a span 300 ms inside incident A was rendered by its NEIGHBOUR B, drawn
 *     700 ms before B's own stated start. One span, two incidents, and the one
 *     that actually owned it showed nothing.
 *
 * It also asked ClickHouse for rows up to 999 ms BELOW the retention floor,
 * against D540's structural claim that the SQL is never asked for rows the
 * sweeper deleted.
 *
 * The bound was expressible all along: `start_time` is `DateTime64(9,'UTC')`
 * and `fromUnixTimestamp64Milli` is the form `queries/traces.ts` already binds.
 * All three legs now take the same millisecond interval, so the window the
 * surface prints and the window the legs were asked for are one interval.
 */
