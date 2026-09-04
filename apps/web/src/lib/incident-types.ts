/**
 * The frozen incidents contract (S7.4 packet §0 + D525, D537, D541).
 *
 * CLIENT-SAFE by the `metrics-types.ts` rule (D366) and, like `change-types.ts`
 * and `slo-types.ts`, with ZERO imports: the list, the detail, the editor and
 * the promote picker all type their props from here, and a client component
 * cannot import a `server-only` module for a type alone (S1.5/D10). The
 * enforcement is machine, not convention — `incident-types.test.ts` asserts
 * `/^import /m.test(source) === false` over this file's own bytes.
 *
 * `PromotableAlertEvent` lives HERE and not in `server/incidents.ts` (D541): it
 * is a prop type of `IncidentsLive`/`IncidentEditor`, both of which the sprint's
 * import fence bars from `@/server/*`, and `resolvedImports` catches `import
 * type` too — so the store is not a legal home for it. Its `severity` is
 * `IncidentSeverity`, declared below with its runtime list; `alert-types.ts`
 * exports only a TYPE for the same three members (its runtime list is
 * module-private at `alerts.ts:57`), so nothing here imports it either.
 *
 * The vocabularies below are NOT their own authority. `services/ingest/
 * pgmigrations/0013_incidents.sql`'s CHECK clauses are (D525), and the test
 * PARSES the members out of that file rather than restating the literals — the
 * `change-types.test.ts` cross-source idiom. A member added on one side without
 * the other moving goes red.
 */

// ---- the three stored vocabularies (D525, authority = 0013_incidents.sql) ----

/** The two states the product has. A CHECK, never an enum, precisely so widening
 *  later is an ordinary migration (`0002_saved_views.sql`'s rule) — and a third
 *  state invented before a product need names it is inventing product.
 *  Deliberately NOT `lib/docs/incidents.ts`'s
 *  `["investigating","monitoring","resolved"]`, which is hand-written MDX copy
 *  for the public status page: a different object that shares a word. */
export type IncidentStatus = "ongoing" | "resolved";

/** The status vocabulary as a runtime list, for the style table and validation. */
export const INCIDENT_STATUSES: readonly IncidentStatus[] = ["ongoing", "resolved"];

/** THREE members, the alert vocabulary VERBATIM including `info` (D525).
 *  Severity is not invented here: promotion copies an `alert_events.severity`,
 *  whose own CHECK is these same three (`0010_alerts.sql:76`), and any narrower
 *  target forces a mapping that overstates an `info` event or understates a
 *  `critical` one — D13 forbids both. The mock's two-member union is the
 *  FIXTURE's; a live vocabulary carrying a member the fixture never used is the
 *  S7.3 precedent (`SlosLive` added `no-data` to a three-key mock table). */
export type IncidentSeverity = "critical" | "warning" | "info";

/** The severity vocabulary as a runtime list. A manual create must SEND one —
 *  the column carries no DEFAULT — and the form pre-selects `warning`, the
 *  middle grade. */
export const INCIDENT_SEVERITIES: readonly IncidentSeverity[] = ["critical", "warning", "info"];

/** How the incident came to exist. Set at create time and NEVER rewritten: the
 *  "from an alert" mark renders off THIS, never off the nullable
 *  `openedFromEventId`, which the retention sweep nulls on a 7-day clock
 *  (D526). A nulled pointer reads as "promoted from an alert that has since
 *  aged out" — never as manual. */
export type IncidentOrigin = "manual" | "alert";

/** The origin vocabulary as a runtime list. */
export const INCIDENT_ORIGINS: readonly IncidentOrigin[] = ["manual", "alert"];

// ---- the timeline vocabulary (D537) -----------------------------------------

/**
 * FOUR kinds, one per thing a leg can actually emit (D537). `alert`, `change`
 * and `trace` are the three read legs (D530); `resolved` is synthesized from
 * the incident's own `ended_at` column.
 *
 * The mock's other four die and do not come back: `pipeline` has no ingest path
 * and `/app/pipelines` is unwired; `metric` is out with the metrics leg (D533,
 * recorded as a narrowing of the run-goal); `action` has no operator-action
 * store (the mock's operator row IS a change event); and `k8s` is out on the
 * S4.4 R3 copy fence — cluster events ARE ingested (`server/adapters.ts:18-20`),
 * so the reason is the fence plus the fact that the only read that exists is
 * per-TRACE and pod-scoped rather than a per-window workspace enumeration.
 *
 * An enum member no leg can emit is D13 in type form, which is why this union
 * is exactly four and `INCIDENT_TIMELINE_KINDS` is pinned deep-equal.
 */
export type IncidentTimelineKind = "alert" | "change" | "trace" | "resolved";

/** The timeline vocabulary as a runtime list, for the style table and the pin. */
export const INCIDENT_TIMELINE_KINDS: readonly IncidentTimelineKind[] = ["alert", "change", "trace", "resolved"];

/**
 * The three kinds that come from a READ — DERIVED from the four, never
 * restated, so the two cannot drift.
 *
 * `resolved` is excluded because it is synthesized from a column this workspace
 * already holds: no leg reads for it, so it can neither be truncated (an
 * omission is a statement about a capped read) nor enter the RCA prompt's three
 * lanes (D554).
 */
export type IncidentTimelineLeg = Exclude<IncidentTimelineKind, "resolved">;

// ---- packet §0 row shapes ---------------------------------------------------

/**
 * `listIncidents(ws)` / `getIncident(ws, id)` row.
 *
 * There is deliberately NO `duration`, NO `timeline` and NO `rca` here. The
 * mock's `"22m"` is a display string and a stored duration is a third copy of
 * two columns that can disagree — the window IS `startedAt`/`endedAt` and the
 * string is `formatIncidentDuration`'s. The timeline is stitched at read time
 * from three other stores (D530) and belongs to `IncidentTimeline`. The RCA is
 * not stored at all (D555): the Explain rail does not store its answers, so
 * neither does this — `0013_incidents.sql` carries no `rca` column.
 */
export interface IncidentRow {
  id: string;
  title: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  origin: IncidentOrigin;
  /** "" when the operator typed none — never null, the column defaults to ''. */
  summary: string;
  /** "" when nothing has been measured; the detail renders the impact box ONLY
   *  when this is non-empty (D546) — an `impact ·` frame with nothing after it
   *  is a fabricated claim. */
  impact: string;
  /** ISO UTC — the incident's OWN start, which the list orders by (D545). */
  startedAt: string;
  /** ISO UTC, or null while ongoing. `resolved ⇔ endedAt !== null` is a table
   *  CHECK, so the pair is never inconsistent (0013:99). */
  endedAt: string | null;
  /** The promoted `alert_events.id`, or null — null ALSO when the event has
   *  since been swept (ON DELETE SET NULL), which is why `origin` and not this
   *  field is what the "from an alert" mark reads (D526). */
  openedFromEventId: string | null;
  /** ISO UTC. */
  createdAt: string;
}

/** The list read's whole answer (D545): every row the workspace holds — the
 *  per-workspace cap IS the bound, so there is no limit and no cursor — plus
 *  the derived header's two numbers, counted in the same pass. The header reads
 *  `{ongoing} ongoing · {total} total` and never `1 in the last 7 days`: the
 *  read applies no time predicate, so that sentence would be a claim about a
 *  filter that does not exist. */
export interface IncidentListPage {
  incidents: IncidentRow[];
  total: number;
  ongoing: number;
}

/** An entry's link. `external` is a FIELD, not a branch on `kind` (D538): a
 *  change event's link is a customer-supplied absolute URL rendered as
 *  `<a target="_blank" rel="noopener noreferrer">` (`changes/page.test.ts:104-107`
 *  pins that), while a trace entry's link is a product-internal route. */
export interface IncidentTimelineLink {
  label: string;
  href: string;
  external: boolean;
}

/**
 * One stitched row. The entry states its OWN grain and never draws a
 * whole-window aggregate at a point instant (D532): `at` is where it is drawn,
 * `until` is how far it extends when the row summarises a span of time (the
 * trace leg's `first_seen`/`last_seen`), and the count with its span rides the
 * DETAIL line — a title reading "2 errors on POST /chat" drawn at 13:04 states
 * a number not reached until 13:19.
 */
export interface IncidentTimelineEntry {
  kind: IncidentTimelineKind;
  /** ISO UTC, fixed-width, so the string IS the instant order (D538). */
  at: string;
  /** ISO UTC end of the row's own grain, or null for a point event. */
  until: string | null;
  title: string;
  /** "" when the row has nothing further to say. */
  detail: string;
  link: IncidentTimelineLink | null;
  /** The row's stable identity — the source row's id where it has one. Third
   *  key of the `(at, sourceRank, key)` total order (D538), and the detail's
   *  anchor id, which is what makes a resolved RCA citation a working link. */
  key: string;
}

/**
 * The stitched timeline plus its honesty states (D536/D540).
 *
 * `omissions` is per-leg and LOCATABLE, never a boolean: each leg is read
 * `LIMIT cap + 1` and the probe row gives `omittedAfterIso` for free — the `at`
 * of the last row the cap kept — so the surface can say "alerts after 13:09 are
 * not shown". A single boolean cannot say that a leg went dark mid-incident, and
 * a hole would then render as absence of activity, which is D13's "a gap is
 * never a zero" inverted.
 *
 * `retentionDays`/`planName` render the SHIPPED D507 register
 * (`· ${retentionDays}d retained on ${planName}`) whenever the read's input was
 * clipped, whether or not rows came back — and never name a date and never
 * assert that specific evidence was deleted.
 *
 * `outsideRetention` is the whole-window-predates-the-floor state: ZERO reads
 * are issued and the surface words itself as a bound on the READ, never as a
 * deletion, which is a past state the product never observed. The field is
 * named `outsideRetention` and not `fullySwept` for exactly that reason.
 */
export interface IncidentTimeline {
  entries: IncidentTimelineEntry[];
  omissions: { leg: IncidentTimelineLeg; omittedAfterIso: string }[];
  retentionDays: number;
  planName: string;
  outsideRetention: boolean;
  /** ISO UTC exclusive upper bound of the window, sampled ONCE and bound to all
   *  three legs (D534) — the incident's `endedAt`, or the render's own clock
   *  while it is ongoing. Half-open `[start, end)`, because incident windows are
   *  adjacent and two back-to-back incidents would otherwise both claim the
   *  event at the shared instant. */
  windowEndIso: string;
}

/**
 * One promotable `alert_events` row for the promote picker (D541, D526).
 *
 * Declared here rather than in the store because the picker's component is
 * fenced off `@/server/*` — see the module header. `producer` is the rule or
 * SLO whose transition emitted the event, or null for a rule-less test
 * notification; it is a label, never an id.
 */
export interface PromotableAlertEvent {
  id: string;
  severity: IncidentSeverity;
  title: string;
  /** ISO UTC — the event's `created_at`, which promotion copies into
   *  `started_at` (D544). */
  at: string;
  producer: string | null;
}

// ---- what the RCA prompt reads (D550/D553/D554) -----------------------------

/**
 * One timeline row as the RCA prompt reads it — the minimal shape, and it is
 * minimal on purpose (D554). No span, no log line and no log body reaches this
 * prompt at all: explaining a trace is the other route's job and is separately
 * metered, so a trace enters here as ONE summary line.
 *
 * `id` is the citable row identity (D553): `evt_` for an alert event, `chg_` for
 * a change event, the trace id for a trace row — and null when the row has no
 * identity to cite. The incident's own `inc_` id is never among them: citing the
 * subject as evidence for itself links to the page the reader is standing on.
 */
export interface IncidentTimelineRow {
  /** One of the three READ legs — the prompt has three lanes, not four (D554). */
  kind: IncidentTimelineLeg;
  id: string | null;
  /** ISO UTC. */
  at: string;
  title: string;
  /** Clipped by the prompt builder, which owns the budget. */
  detail: string;
  /** The service the row is about, or null — an alert event carries no service
   *  column, so it is honestly absent rather than guessed. */
  service: string | null;
  /** The alert event's own severity, or null for a row that has none. */
  severity: IncidentSeverity | null;
}

/**
 * The incident as the Explain rail's second subject (D550):
 * `ExplainSubject = { kind: "trace"; trace: Trace } | { kind: "incident"; incident: IncidentSubject }`.
 *
 * This carries exactly what D554 says is SENT, plus the incident's own id
 * (D553 needs it: excluding `inc_` from the citable set means knowing it):
 * the title and summary a human wrote about it, its window, and the rows — and
 * nothing else. No workspace name, no account, no other incident, no channel
 * target, no `key_id`. The reference index is built from these SAME rows, which
 * is what makes a resolved citation a working link rather than a claim.
 */
export interface IncidentSubject {
  id: string;
  title: string;
  /** "" when the operator typed none. */
  summary: string;
  /** ISO UTC — the window's inclusive start, already clipped to the plan's
   *  retention floor where that applies (D540). */
  startedAt: string;
  /** ISO UTC — the window's EXCLUSIVE end, the same instant the timeline was
   *  stitched against (D534): one clock, sampled once. */
  windowEndIso: string;
  rows: IncidentTimelineRow[];
}

// ---- the three formatters, ONE definition each (packet §0) -------------------
//
// `nowMs` is REQUIRED and defaultless on both formatters that take it — the
// `lib/format.ts:45-57` `timeAgo` discipline, for the same measured reason
// (D50/D64). A `= Date.now()` default would age every mock-mode row against the
// wall clock and every live row against whatever clock happened to be nearest;
// neither is right for both modes, so the caller that knows the mode names it.
// `incident-types.test.ts` pins that with `Function.prototype.length`, which
// counts parameters up to the first defaulted one.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** `YYYY-MM-DD`, UTC, from the INSTANT — never a slice of the input string,
 *  which may legally carry an offset (`2026-09-04T01:04+02:00` is 2026-09-03 in
 *  UTC, and a slice would print the wrong day). */
/**
 * The rendered absence, one definition. An instant the product cannot read is
 * ABSENT, not zero and not guessed (D13) — the register `SlosLive` renders for
 * a measurement that does not exist yet.
 */
const NO_INSTANT = "—";

/**
 * The instant an ISO string names, or null when it names none.
 *
 * The type check is the load-bearing half, not the finite check. `new Date(x)`
 * on an unparseable STRING is Invalid Date and `getTime()` is NaN, which is
 * obvious. But `new Date(null)` is the EPOCH — finite, valid, and rendered it
 * reads `1970-01-01 00:00:00 UTC`: a fully plausible timestamp no reader could
 * tell from a real one. `tsc` blocks a null on the live path, so this guards
 * the runtime edge where untyped data reaches a formatter, and it is the
 * PLAUSIBLE fabrication rather than the obvious one that D13 is about.
 */
function instantOf(value: unknown): Date | null {
  if (typeof value !== "string" || value === "") return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function utcDay(d: Date): string {
  return `${String(d.getUTCFullYear()).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `HH:MM`, UTC. */
function utcHm(d: Date): string {
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/**
 * How long the incident has run, FLOORED, in the largest two units that carry
 * information: `"under a minute"`, `"22m"`, `"1h 12m"`, `"2d 3h"`.
 *
 * Under a minute renders words and never `"0m"` — a resolved incident is not a
 * zero-length one, and `"0m"` reads as a bug in the clock rather than as a fast
 * recovery.
 *
 * CLAMPED AT ZERO. The stored pair cannot go backwards (`0013_incidents.sql:100`
 * CHECKs `ended_at >= started_at`), but an ONGOING incident is measured against
 * a clock the caller supplies, and an incident opened with a `started_at` a few
 * seconds ahead of the render's clock is an ordinary skew — not a reason to
 * render `"-1m"`, and not a reason to fall through the unit ladder into a wrong
 * bucket.
 */
export function formatIncidentDuration(startedAt: string, endedAt: string | null, nowMs: number): string {
  const end = endedAt === null ? nowMs : Date.parse(endedAt);
  const ms = Math.max(0, end - Date.parse(startedAt));
  // `Math.max(0, NaN)` is NaN, and NaN fails every `<` below, so an unparseable
  // instant would fall THROUGH the unit ladder into the days bucket and render
  // `NaNd NaNh` — the exact miss the clamp above exists to prevent, one input
  // class over. The type system blocks this on the live path (`startedAt` is a
  // non-nullable string and the store serializes with `toISOString()`), so this
  // is the belt to that braces: an instant the product cannot read renders as
  // absent (D13), never as a number and never as a fabricated one.
  if (!Number.isFinite(ms)) return NO_INSTANT;
  if (ms < MINUTE_MS) return "under a minute";
  const minutes = Math.floor(ms / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(ms / DAY_MS)}d ${hours % 24}h`;
}

/**
 * The window label, with the duration on the end — the ONE renderer of an
 * incident's time range:
 *
 *   resolved: `2026-09-04 13:04 → 13:26 UTC · 22m`
 *   ongoing:  `2026-09-04 13:04 UTC → ongoing · 22m so far`
 *
 * When the end's UTC calendar date differs from the start's, the end prints its
 * FULL date: a window over midnight would otherwise render `23:50 → 00:12` and
 * read as going backwards. The comparison is on the rendered UTC day, not on
 * elapsed hours — a four-minute window at 23:58 crosses a date and a 23-hour one
 * inside a day does not.
 *
 * One zone, named once, and it is UTC everywhere the product prints an instant
 * (the UTC computation `fmtClock` uses; the printed zone label is this
 * formatter's own, since fmtClock prints none): a label that omits the zone is
 * read in the reader's own.
 */
export function formatIncidentWindow(startedAt: string, endedAt: string | null, nowMs: number): string {
  const start = instantOf(startedAt);
  const duration = formatIncidentDuration(startedAt, endedAt, nowMs);
  if (start === null) return NO_INSTANT;
  if (endedAt === null) return `${utcDay(start)} ${utcHm(start)} UTC → ongoing · ${duration} so far`;
  const end = instantOf(endedAt);
  if (end === null) return NO_INSTANT;
  const endLabel = utcDay(end) === utcDay(start) ? utcHm(end) : `${utcDay(end)} ${utcHm(end)}`;
  return `${utcDay(start)} ${utcHm(start)} → ${endLabel} UTC · ${duration}`;
}

/**
 * A timeline row's instant: `2026-09-04 13:04:52 UTC`.
 *
 * SECONDS are included and the date is not optional. A timeline's whole value is
 * ordering inside a minute — the mock's own fixture carries `13:05:02` and
 * `13:05:41` (`mock/incident.ts:53,60`) — and a rail that renders both as
 * `13:05` states that two rows happened at once when the stitch knows they did
 * not.
 */
export function formatIncidentClock(iso: string): string {
  const d = instantOf(iso);
  // Unreadable renders as absent. Note WHICH input this is really guarding:
  // `new Date(null)` is not NaN, it is the EPOCH, so a null instant would
  // render `1970-01-01 00:00:00 UTC` — a fully plausible, entirely fabricated
  // timestamp no reader could tell from a real one. That is worse than the
  // obviously-broken NaN case, and it is the one D13 actually cares about.
  if (d === null) return NO_INSTANT;
  return `${utcDay(d)} ${utcHm(d)}:${pad2(d.getUTCSeconds())} UTC`;
}
