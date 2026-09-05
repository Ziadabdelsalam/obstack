import "server-only";
import type { IncidentSubject, IncidentTimelineLeg, IncidentTimelineRow } from "@/lib/incident-types";
import type { ExplainPrompt } from "./types";
import { EVIDENCE_SEPARATOR, LABELS, NO_REFERENCE } from "./validate";

/**
 * What the model is given for an incident (S7.4 packet D554): the incident's
 * own title and summary — a human wrote both, about this incident — the window
 * that was READ, and the timeline rows inside it, each as one line. Nothing
 * else. `prompt.ts` is this file's structural twin, and the differences are
 * the differences between the two subjects.
 *
 * The subject arrives already scoped: the route read the incident through the
 * workspace-scoped store and stitched its rows through the same facade the
 * timeline page uses (D539), so the tenancy question is answered before this
 * file sees anything. `IncidentSubject.startedAt` is documented as ALREADY
 * clipped to the plan's retention floor (D540), which is why the header below
 * says "window read" and never "started" — the instant may not be the
 * incident's own start, and this file cannot tell.
 *
 * FOUR things are deliberately withheld from the provider, and the first is
 * withheld more strongly than the trace prompt manages:
 *
 *  1. `llm.prompt` and `llm.completion` — the customer's own model traffic.
 *     A trace enters this prompt as ONE summary line (a count of failing
 *     spans grouped by service and span name, with an example trace id), and
 *     NO span, no log line and no log body reaches it at all. Explaining a
 *     trace is the other route's job and is separately metered; an RCA costs
 *     one Explain run and reads ABOUT traces without sending any trace's
 *     contents, so the "no LLM prompts or completions" promise is true by
 *     construction rather than by filtering. `IncidentTimelineRow` carries no
 *     field a span or log could ride in, and this file reads only its seven.
 *  2. anything outside this incident's window and workspace — no workspace
 *     name, no account, no other incident. An analysis is about the thing the
 *     user opened.
 *  3. `notification_channels.target` — a Slack webhook URL is a credential
 *     (D487). The alerts store never selects the column and the row has no
 *     field for it; this file would not send it if it did.
 *  4. `change_events.key_id` — provenance, never rendered anywhere.
 *
 * The four hold by PROJECTION: `describeIncident` names the fields it reads,
 * and a subject that arrives wider than its type (a spread store row, a later
 * widening) leaks none of the extra. `incident-prompt.test.ts` proves that
 * with sentinels placed exactly where each withheld thing would sit, RED
 * against `JSON.stringify(incident)`.
 *
 * The incident's OWN `inc_` id is not sent either: D553 excludes it from the
 * citable set because it is the one self-reference a model reliably reaches
 * for, and the cleanest way to keep an id out of the answer is to never hand
 * it over.
 *
 * ---- the caps: PER LANE, not one flat budget ----
 *
 * D554's reason: a flapping rule produces alert events at machine rate, and
 * under a flat cap over the time-ordered rows whichever kind happens to be
 * latest is what gets cut — usually the change events, which are usually what
 * a root cause IS. Three lanes, because the stitch produces three read legs
 * (D530) and there is no metrics leg (D533); a cap on a lane the stitch does
 * not produce would cap nothing. Each lane states its own truncation when it
 * bites, in `prompt.ts`'s exact form (`alerts (60 of 412, truncated):`), and
 * the lanes are cut in INPUT order — the stitcher's D538 total order — so the
 * rows kept are the earliest of each kind, never re-sorted here.
 *
 * ⟨S7.4 T5 plan correction, D575 — D554's REASON is overstated; its ruling
 * stands. The stitcher already caps every leg at `TIMELINE_LEG_CAP = 50`
 * (D536), so "hundreds of alert events" never reach this file: the most a
 * stitched subject can carry is 50 alerts, 70 changes (50 in-window + the
 * 20-row lead-in band) and 50 trace groups — 170 rows, and `MAX_ALERTS = 60`
 * is a cap that cannot bite on that path. What DOES bite is `MAX_CHANGES`
 * (70 → 40) and `MAX_TRACES` (50 → 20), and a flat 120 over 170 time-ordered
 * rows would still cut whichever lane is latest, so the lanes are still the
 * right shape. The numbers are kept as ruled: they are this module's contract
 * on the unbounded array its type accepts, not a claim about the stitcher.⟩
 *
 * `MAX_TIMELINE_ROWS` is the SUM of the three lanes rather than a second
 * literal: the packet states 120 as a ceiling over 60/40/20, which sum to 120
 * exactly, and two declared numbers are two numbers that can disagree. The
 * test pins the sum at the packet's 120.
 *
 * ---- honesty about the subset ----
 *
 * The stitcher's ceiling is 171 entries (three legs of 50, a band of 20, the
 * synthesized `resolved` row that never reaches this file) and this file's is
 * 120, so on a busy incident the analysis reads a strict subset of what the
 * page shows. When ANY lane truncates, the document says so with both numbers
 * — it is not keyed on the total crossing 120, because 100 alerts and nothing
 * else is 100 rows and still a subset. And the system prompt tells the model
 * that a lane's end is the end of what it was shown, never the moment things
 * went quiet: `IncidentSubject` does not carry the stitcher's own per-leg
 * omissions (D536), so a leg the STITCHER capped would otherwise read as
 * complete here. ⟨Recorded as D576 — a gap in D554's "what IS sent", not
 * closable in this file.⟩
 */

/** D554's lanes. */
export const MAX_ALERTS = 60;
export const MAX_CHANGES = 40;
export const MAX_TRACES = 20;

/** The document's whole ceiling — DERIVED, see the header. */
export const MAX_TIMELINE_ROWS = MAX_ALERTS + MAX_CHANGES + MAX_TRACES;

/** `prompt.ts`'s `MAX_LOG_BODY`, for the same reason: a row's detail is a
 *  sentence or two, and a pasted stack trace is a bill, not an input. */
export const MAX_DETAIL = 300;

/**
 * Keyed by the leg type so a fourth read leg cannot be added to the stitch
 * without this table going red under `tsc` — a lane with no cap is a lane
 * with no truncation line.
 */
const LANE_CAP: Record<IncidentTimelineLeg, number> = {
  alert: MAX_ALERTS,
  change: MAX_CHANGES,
  trace: MAX_TRACES,
};

/** The lane headings, in the order the document lists them. */
const LANES: readonly { kind: IncidentTimelineLeg; heading: string }[] = [
  { kind: "alert", heading: "alerts" },
  { kind: "change", heading: "changes" },
  { kind: "trace", heading: "traces" },
];

const SYSTEM = [
  "You are reading one incident from an observability tool — the alerts, changes and error traces that share its window — and explaining why it happened, for the engineer who owns the services involved.",
  "Ground every claim in the timeline rows below. If the rows do not show why the incident happened, say that they do not — a stated gap is useful, an invented cause is not.",
  "Each lane lists what was read for this window and may have been capped before the window ended: treat the end of a lane as the end of what you were shown, never as the moment things went quiet.",
  "A trace row is one summary line — how many spans failed, grouped by service and span name, with an example trace id — and none of the trace's own content. Do not describe spans or logs you were not given.",
  "Cite evidence only by the exact alert, change or trace id given to you. Never invent an id; write '-' when a line has no id behind it.",
  "",
  "Answer as labelled lines, one line each, no markdown, no preamble:",
  `${LABELS.headline}: one sentence naming what happened`,
  `${LABELS.where}: the service or services the incident happened in`,
  `${LABELS.cause}: what actually went wrong, in a few sentences`,
  `${LABELS.evidence}: <alert, change or trace id, or ${NO_REFERENCE}> ${EVIDENCE_SEPARATOR} short label ${EVIDENCE_SEPARATOR} what it shows`,
  `${LABELS.suggestion}: what to do next`,
  "",
  `Two to five ${LABELS.evidence} lines. Every other label appears exactly once.`,
].join("\n");

export function buildIncidentPrompt(incident: IncidentSubject): ExplainPrompt {
  return { system: SYSTEM, user: describeIncident(incident) };
}

/**
 * The rows the prompt describes: the first `LANE_CAP[kind]` of each lane, in
 * INPUT order. Exported because it is the (d)↔(e) coupling (D553): the
 * reference index must be built from THESE rows and not from `incident.rows`,
 * so that an id the model may cite is an id the model was given, and a cap
 * that drops a row drops it from both.
 */
export function describedIncidentRows(rows: readonly IncidentTimelineRow[]): IncidentTimelineRow[] {
  const seen: Record<IncidentTimelineLeg, number> = { alert: 0, change: 0, trace: 0 };
  return rows.filter((row) => seen[row.kind]++ < LANE_CAP[row.kind]);
}

/**
 * A row is ONE line by contract, and a row's text is the customer's — an alert
 * detail the Go deliverer wrote, a change detail their CI posted. A newline in
 * it would open a line that reads like a row with an id behind it, so control
 * characters are flattened to a space (the `validate.ts` `safeReference`
 * regex). Flattened, not censored: the text is still sent.
 */
const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f]+/g, " ");

function describeRow(row: IncidentTimelineRow): string {
  const severity = row.severity ? ` ${row.severity}` : "";
  const service = row.service ? ` ${oneLine(row.service)}` : "";
  const detail = row.detail ? ` — ${oneLine(row.detail).slice(0, MAX_DETAIL)}` : "";
  return `  ${row.id ?? NO_REFERENCE} ${row.at}${severity}${service}: ${oneLine(row.title)}${detail}`;
}

function describeIncident(incident: IncidentSubject): string {
  const rows = describedIncidentRows(incident.rows);
  const total = incident.rows.length;

  // The summary is the operator's own prose and may run to several lines;
  // continuation lines are indented so none can be read as a lane heading.
  const summary =
    incident.summary === "" ? "none written" : incident.summary.split(/\r?\n/).map(oneLine).join("\n  ");

  const lines = [
    `incident: ${oneLine(incident.title)}`,
    `summary: ${summary}`,
    `window read: ${incident.startedAt} to ${incident.windowEndIso} (end exclusive)`,
  ];

  if (rows.length < total) {
    // Both numbers are THIS document's: `total` is the rows the subject
    // carries (the stitcher's read, itself capped per leg — D536), never a
    // claim about how many the window truly held, and the page is not named
    // with a count because it also renders the synthesized `resolved` row and
    // the stitcher's own truncation notes, neither of which is a row here.
    lines.push(
      "",
      `${rows.length} of the ${total} timeline rows read for this window are listed below; the rest are on the incident page. ` +
        "The rows that were cut are not evidence of quiet — if the listed rows do not explain the incident, say what is missing rather than guessing.",
    );
  }

  for (const lane of LANES) {
    const laneTotal = incident.rows.filter((row) => row.kind === lane.kind).length;
    const kept = rows.filter((row) => row.kind === lane.kind);
    lines.push(
      "",
      `${lane.heading} (${kept.length}${kept.length < laneTotal ? ` of ${laneTotal}, truncated` : ""}):`,
    );
    for (const row of kept) lines.push(describeRow(row));
  }

  return lines.join("\n");
}

/**
 * The third refusal (D558): an incident whose window holds no READ row —
 * no alert, no change, no trace; the synthesized `resolved` entry is not
 * evidence. Refused BEFORE the spend, because running a model over an empty
 * timeline is asking it to invent a cause and billing for the invention. Lives
 * in this swept directory so the D206 wording mirror reads it, and is quoted
 * into `/docs/explain` by `lib/docs/mirror.test.ts`.
 */
export const NO_EVIDENCE_DETAIL =
  "This incident's window contains no alerts, changes or traces to read, so there was nothing to analyse and no run was made.";
