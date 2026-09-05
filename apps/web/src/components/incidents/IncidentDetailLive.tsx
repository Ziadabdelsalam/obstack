import Link from "next/link";
import { ArrowUpRight, BellRing, CircleCheck, GitCommitHorizontal, ListTree } from "lucide-react";
import {
  INCIDENT_TIMELINE_KINDS,
  formatIncidentClock,
  formatIncidentWindow,
  type IncidentRow,
  type IncidentTimeline,
  type IncidentTimelineEntry,
  type IncidentTimelineKind,
  type IncidentTimelineLeg,
  type IncidentTimelineOmission,
  type IncidentTimelineRow,
} from "@/lib/incident-types";
import { IncidentControls } from "./IncidentEditor";
import { IncidentNotFound } from "./IncidentNotFound";
import { IncidentRcaRail } from "./IncidentRcaRail";
import { IncidentOriginMark, IncidentSeverityPill, IncidentStatusPill } from "./IncidentsLive";

/**
 * One incident, live (S7.4 T6, D539/D540/D546): a SERVER component with zero
 * fetching — `incidents/[id]/page.tsx` did every read, in D539's order (the
 * row and the plan, then the stitch), and this file decides what the reader
 * sees. `incident === null` is the tenancy boundary read from the outside: an
 * id from another workspace answers exactly as an invented one does (D440),
 * through the ONE definition of that sentence, `IncidentNotFound`.
 *
 * Nothing here imports `@/mock/`, `IncidentRca` (the mock's typewriter, banned
 * from the live graph by name) or `@/server/*`. The stitched timeline's type is
 * therefore stated STRUCTURALLY below from the client-safe contract rather
 * than imported from `server/incident-timeline.ts`: the sprint's import fence
 * bars this file from `@/server/*`, and `resolvedImports` catches `import
 * type` too (D541's reason, one module over). ⟨S7.4 T6 plan note: T4 already
 * recorded that `windowStartIso`/`inputClipped` belong on the shipped
 * `IncidentTimeline`; when that move lands in `lib/incident-types.ts` the
 * local alias below is the one line to delete.⟩
 *
 * THE THREE HONESTY STATES (D540), each a rendered statement, none a guess:
 *   - clipped: the SHIPPED D507 register `· {n}d retained on {plan}` beside
 *     the window label, rendered off `timeline.inputClipped` — reported by the
 *     stitcher, NEVER derived here from `windowStartIso !== startedAt` (D574:
 *     that derivation is blind to a floor landing inside the changes band) —
 *     and rendered whether or not rows came back. It names no date and never
 *     says anything was deleted.
 *   - outsideRetention: ZERO reads were issued, and the sentence is a bound on
 *     the READ ("no evidence was read for it"), never "was deleted" — a past
 *     state the product never observed.
 *   - the per-leg omissions, rendered as COUNTS, never as instants (see
 *     `omissionSentence`).
 *
 * The rail's style table is this file's own and has exactly the four kinds a
 * leg can emit (D537); the mock's other four are absent, not styled.
 */
const kindStyle: Record<IncidentTimelineKind, { icon: typeof BellRing; color: string; label: string }> = {
  alert: { icon: BellRing, color: "var(--color-warn)", label: "alert" },
  change: { icon: GitCommitHorizontal, color: "var(--color-agent)", label: "change" },
  trace: { icon: ListTree, color: "var(--color-llm)", label: "traces" },
  resolved: { icon: CircleCheck, color: "var(--color-ok)", label: "resolved" },
};

/** What one row of each READ leg is, for the omission sentences — singular;
 *  `legNoun` pluralises. On the live path a count is always a cap (20 or 50),
 *  but a sentence builder that only works above one is a bug waiting. */
const LEG_ROW: Record<IncidentTimelineLeg, string> = {
  alert: "alert event",
  change: "change event",
  trace: "error trace group",
};
const legNoun = (leg: IncidentTimelineLeg, n: number): string => `${LEG_ROW[leg]}${n === 1 ? "" : "s"}`;

/**
 * The stitcher's answer, typed from the client-safe contract (see the header):
 * the shipped `IncidentTimeline` plus the inclusive start actually read, the
 * reported clip, and the RCA rows projected from the same capped legs.
 */
type StitchedTimeline = IncidentTimeline & {
  windowStartIso: string;
  inputClipped: boolean;
  rows: IncidentTimelineRow[];
};

/** The live capability sentence (D537), verbatim: it names only what is read. */
const CAPABILITY =
  "stitched from this workspace's own alert events, change events and error traces inside the incident window — the same rows /app/alerts, /app/changes and /app/issues show.";

/**
 * The three READ legs, derived from the vocabulary and never typed (D537):
 * the empty-state sentence is built from this list, so a leg added to or
 * removed from `INCIDENT_TIMELINE_KINDS` changes the sentence with it.
 */
const READ_LEGS = INCIDENT_TIMELINE_KINDS.filter((kind): kind is IncidentTimelineLeg => kind !== "resolved");
const READ_LEGS_PHRASE = `${READ_LEGS.slice(0, -1).join(", ")} or ${READ_LEGS[READ_LEGS.length - 1]}`;
/** "were read" and not "happened": on a clipped window the read covered part of it. */
const NOTHING_READ = `no ${READ_LEGS_PHRASE} rows were read inside this window`;

/**
 * One leg's truncation as a COUNT of what is shown, never as an instant
 * (D583, correcting D536's example sentence).
 *
 * The contract carries `omittedAfterIso` (an ascending cap's last KEPT row)
 * and `omittedBeforeIso` (the band's earliest kept row), and T4 handed this
 * surface three reasons a sentence built on them would be FALSE (F6–F8):
 * the instant names the last row KEPT, so rows dropped AT that same instant
 * make "after X is not shown" untrue; on the trace leg `first_seen` is whole
 * seconds by construction, so groups routinely share the boundary instant
 * (a case was shown where all fifty kept groups and the dropped one sit at
 * ONE instant); and `formatIncidentClock` renders seconds, so even an honest
 * boundary can print the same string as the first dropped row. A count of the
 * rows on the page is true in every one of those cases, and "the first N" is
 * exact because each ascending leg is read `ORDER BY at` and the cap keeps
 * the earliest rows. The band is the one leg capped the OTHER way (D573): it
 * keeps the changes NEAREST the start, so its dropped rows are the earliest,
 * and it is named as the band so it cannot be read as a gap inside the window.
 */
function omissionSentence(omission: IncidentTimelineOmission, shown: number): string {
  // "the rest", not "later ones" / "earlier ones": at a tie the dropped row
  // shares the boundary instant with a kept one, so it is neither later nor
  // earlier. "read for this window", not "in the window": under a clipped
  // read (D540) the rows are the read's, which covered part of the window.
  if (omission.band) {
    return `the ${shown} ${legNoun("change", shown)} nearest the start, read from the hour before; the rest are not shown`;
  }
  return `showing the first ${shown} ${legNoun(omission.leg, shown)} read for this window; the rest are not shown`;
}

/** How many rows of a leg the page holds — in-window for an ascending cap, the band for the band. */
function shownCount(entries: IncidentTimelineEntry[], omission: IncidentTimelineOmission, windowStartIso: string): number {
  return entries.filter(
    (entry) =>
      entry.kind === omission.leg &&
      (omission.band ? entry.at < windowStartIso : entry.at >= windowStartIso),
  ).length;
}

export function IncidentDetailLive({
  incident,
  timeline,
  explain,
  nowMs,
}: {
  incident: IncidentRow | null;
  timeline: StitchedTimeline;
  /** The plan's Explain month, resolved on the server by the one quota reader (D226). */
  explain: { used: number; quota: number };
  /** The render's one clock, for an ongoing duration (D50/D64). */
  nowMs: number;
}) {
  if (incident === null) return <IncidentNotFound />;

  // D558, the same predicate the RCA route refuses `no-evidence` on: a row
  // INSIDE the window. The changes band is context from the hour before, not
  // evidence, and a control that leads to a refusal by construction is not a
  // control.
  const canRunRca = timeline.rows.some((row) => row.at >= timeline.windowStartIso);
  // The rows read INSIDE the window (D586): the same predicate as the control
  // above, so the empty-window statement below is exactly the sentence for
  // the control it hides. The band's change rows are context from the hour
  // BEFORE (D535), not a read of the window — a band-only timeline was
  // rendering three "before the window" rows and no statement about the
  // window at all. The synthesized `resolved` row was never read (D537).
  const readInWindow = timeline.entries.filter((entry) => entry.kind !== "resolved" && entry.at >= timeline.windowStartIso);
  const changesLegEmpty = !timeline.entries.some((entry) => entry.kind === "change");

  return (
    <div className="mx-auto max-w-3xl px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Incident</h1>
        <Link href="/app/incidents" className="font-mono text-[11px] text-faint hover:text-ink">
          ← all incidents
        </Link>
      </div>

      <section className="rounded-lg border border-line bg-surface">
        {/* header */}
        <div className="border-b border-line px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[12px] text-faint">{incident.id}</span>
            <IncidentStatusPill status={incident.status} />
            <IncidentSeverityPill severity={incident.severity} />
            <span className="font-mono text-[11px] text-faint">
              {formatIncidentWindow(incident.startedAt, incident.endedAt, nowMs)}
              {timeline.inputClipped && ` · ${timeline.retentionDays}d retained on ${timeline.planName}`}
            </span>
            <IncidentOriginMark incident={incident} />
          </div>
          <h2 className="mt-1.5 text-[16px] font-semibold text-ink">{incident.title}</h2>
          {incident.summary !== "" && (
            <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-mid">{incident.summary}</p>
          )}
          {/* ONLY when something was measured (D546): an `impact ·` frame with
              nothing after it is a fabricated claim. */}
          {incident.impact !== "" && (
            <p
              className="mt-2.5 rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed"
              style={{
                color: "var(--color-warn)",
                borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
                background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
              }}
            >
              impact · {incident.impact}
            </p>
          )}
          <IncidentControls incident={incident} />
          <IncidentRcaRail incidentId={incident.id} used={explain.used} quota={explain.quota} canRunRca={canRunRca} />
        </div>

        {/* timeline */}
        <div className="px-4 py-4">
          <h3 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-faint">timeline</h3>

          {timeline.outsideRetention && (
            <p className="mb-3 font-mono text-[11px] text-mid">
              {`this window is older than the ${timeline.retentionDays} days ${timeline.planName} retains, so no evidence was read for it`}
            </p>
          )}
          {timeline.omissions.map((omission) => (
            <p key={`${omission.leg}:${omission.band ? "band" : "window"}`} className="mb-1.5 font-mono text-[10.5px] text-faint">
              {omissionSentence(omission, shownCount(timeline.entries, omission, timeline.windowStartIso))}
            </p>
          ))}
          {!timeline.outsideRetention && readInWindow.length === 0 && (
            <p className="mb-3 font-mono text-[11px] text-mid">{NOTHING_READ}</p>
          )}
          {/* An empty changes leg is told why (D537) rather than shown a quiet
              hour: the same recipe link `ChangesLive` is pinned to carry. */}
          {!timeline.outsideRetention && changesLegEmpty && (
            <p className="mb-3 font-mono text-[10.5px] text-faint">
              no change events were read for this window or its lead-in — post one from CI:{" "}
              <Link
                href="/app/docs/connectors/github-actions"
                className="inline-flex items-center gap-1 hover:underline"
                style={{ color: "var(--color-api)" }}
              >
                the GitHub Actions recipe <ArrowUpRight className="h-3 w-3" />
              </Link>
            </p>
          )}

          {timeline.entries.length > 0 && (
            <div className="relative ml-2 border-l border-line-strong pl-6">
              {timeline.entries.map((entry) => {
                const s = kindStyle[entry.kind];
                const Icon = s.icon;
                // The band (D535): change rows from the hour BEFORE the window,
                // labelled as such so context is never read as the story.
                const beforeWindow = entry.kind === "change" && entry.at < timeline.windowStartIso;
                return (
                  // `id` is the row's stable key: the RCA's `eventRef` citation
                  // is an in-page `#<id>` anchor onto exactly this element (D553).
                  <div key={entry.key} id={entry.key} className="relative scroll-mt-16 pb-5 last:pb-0">
                    <span
                      className="absolute -left-[35px] flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-surface"
                      style={{ borderColor: s.color }}
                    >
                      <Icon className="h-2.5 w-2.5" style={{ color: s.color }} />
                    </span>
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      <span className="font-mono text-[11px] text-faint">{formatIncidentClock(entry.at)}</span>
                      <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: s.color }}>
                        {s.label}
                      </span>
                      {beforeWindow && (
                        <span className="font-mono text-[9px] uppercase tracking-widest text-faint">before the window</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[13.5px] font-medium text-ink">{entry.title}</p>
                    {entry.detail !== "" && (
                      <p className="mt-0.5 whitespace-pre-line text-[12.5px] leading-relaxed text-mid">{entry.detail}</p>
                    )}
                    {/* Two link shapes, discriminated by the FIELD (D538): a
                        change event's link is the customer's own source system
                        and renders as an external anchor with the D499 rel; an
                        alert's or a trace's is a product route and renders as
                        a Link. Never a branch on kind. */}
                    {entry.link &&
                      (entry.link.external ? (
                        <a
                          href={entry.link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                          style={{ color: "var(--color-api)" }}
                        >
                          {entry.link.label} <ArrowUpRight className="h-3 w-3" />
                        </a>
                      ) : (
                        <Link
                          href={entry.link.href}
                          className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                          style={{ color: "var(--color-api)" }}
                        >
                          {entry.link.label} <ArrowUpRight className="h-3 w-3" />
                        </Link>
                      ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* A CAPABILITY sentence, not story data (D537): it names only what the
          three legs read, and the surfaces that show the same rows. */}
      <p className="mt-3 font-mono text-[10.5px] leading-relaxed text-faint">{CAPABILITY}</p>
    </div>
  );
}
