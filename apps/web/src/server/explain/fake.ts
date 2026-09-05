import "server-only";
import type { IncidentSubject, IncidentTimelineRow } from "@/lib/incident-types";
import type { LogRecord, Span, Trace } from "@/lib/types";
import { describedIncidentRows } from "./incident-prompt";
import type { ExplainProvider } from "./types";
import { EVIDENCE_SEPARATOR, LABELS } from "./validate";

/**
 * The default provider through M3 (D168) and the only one CI and the e2e drive
 * ever run — U6 is absolute: CI never spends. It is not a stub. It streams the
 * same document format the model is asked for, through the same prompt
 * assembly, the same chunk framing and the same validation, so a green e2e run
 * is a proof about the Explain path and not about a canned string.
 *
 * It also carries NO credential: there is no key to leak because there is no
 * request to sign (the `obstack-test-no-credential` precedent taken one step
 * further — the fake needs no placeholder because it never authenticates).
 *
 * What it writes is honest by construction: every line is a restatement of a
 * field the subject — this trace, or this incident's timeline — actually
 * carries, and the suggestion says plainly that no model was called. A deployment running fake mode therefore cannot show a
 * person a reading nobody made — which is the same rule D102 applies to a
 * deployment with no model configured at all.
 */

const CHUNK = 48;
const MAX_EVIDENCE = 4;
const DETAIL_CLIP = 160;

export const fakeExplain: ExplainProvider = {
  mode: "fake",

  /** Always available: nothing to configure, nothing to be missing. */
  unavailable() {
    return null;
  },

  async *stream(_prompt, subject) {
    // One fake, both subjects (D550): the incident RCA path CI walks is this
    // same stream, chunk framing and validation — not a stub beside them.
    const document =
      subject.kind === "trace" ? fakeExplainDocument(subject.trace) : fakeIncidentDocument(subject.incident);
    for (let at = 0; at < document.length; at += CHUNK) {
      yield document.slice(at, at + CHUNK);
    }
  },
};

/**
 * The fake's whole answer, exported because it is what the deterministic tests
 * and the drive assert against — one definition of "what fake mode says".
 */
export function fakeExplainDocument(trace: Trace): string {
  const failed = trace.spans.find((span) => span.status === "error");
  const slowest = [...trace.spans].sort((a, b) => b.durationMs - a.durationMs)[0];
  const subject = failed ?? slowest;
  const loud = trace.logs.filter((log) => log.severity === "error" || log.severity === "fatal");

  const lines = [
    `${LABELS.headline}: ${headline(trace, failed, slowest)}`,
    `${LABELS.where}: ${where(trace, subject)}`,
    `${LABELS.cause}: ${cause(subject, loud)}`,
  ];
  for (const line of evidence(subject, loud.length ? loud : trace.logs)) {
    lines.push(`${LABELS.evidence}: ${line}`);
  }
  lines.push(
    `${LABELS.suggestion}: This deployment runs Explain in fake mode (OBSTACK_EXPLAIN_MODE=fake), so the lines ` +
      `above restate what the trace itself records and no model read them — the operator of this deployment can configure one.`,
  );
  return lines.map(oneLine).join("\n");
}

/**
 * Every line of the document is ONE line. Trace content is not ours — a log body
 * is routinely a stack trace, and a newline inside one would end an EVIDENCE
 * line early (dropping the detail it was carrying) or, worse, let the next
 * fragment start with a label the parser then believes. Flattened at the point
 * the line is written, so the document the panel streams and the document
 * `validate.ts` parses cannot disagree.
 */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ");
}

function headline(trace: Trace, failed: Span | undefined, slowest: Span | undefined): string {
  if (failed) return `${failed.name} failed in ${failed.service}`;
  if (slowest) return `No span on this trace failed; ${slowest.name} is its slowest step at ${slowest.durationMs}ms`;
  return `This trace records no spans, so it shows nothing about ${trace.rootName}`;
}

function where(trace: Trace, subject: Span | undefined): string {
  if (!subject) return `Unknown — ${trace.service} recorded no spans for this trace.`;
  return (
    `${subject.layer} layer · ${subject.service}${subject.pod ? ` · pod ${subject.pod}` : ""}, ` +
    `+${subject.startMs}ms into a ${trace.durationMs}ms trace.`
  );
}

function cause(subject: Span | undefined, loud: LogRecord[]): string {
  if (!subject) return "The trace carries no spans, so it names no failing step.";
  const reported = subject.statusMessage
    ? `The span reports "${subject.statusMessage}".`
    : "The span reports no status message.";
  const logs = loud.length
    ? `${loud.length} correlated log line${loud.length === 1 ? "" : "s"} at error or above accompany it.`
    : "No correlated log line at error or above accompanies it.";
  return `${reported} ${logs}`;
}

function evidence(subject: Span | undefined, logs: LogRecord[]): string[] {
  const lines: string[] = [];
  if (subject) {
    lines.push(
      [
        subject.id,
        `span · ${subject.name}`,
        `${subject.status} after ${subject.durationMs}ms${subject.statusMessage ? ` — ${subject.statusMessage}` : ""}`,
      ].join(` ${EVIDENCE_SEPARATOR} `),
    );
  }
  for (const log of logs.slice(0, MAX_EVIDENCE - lines.length)) {
    lines.push(
      [log.id, `log · ${log.severity} ${log.pod}`, log.body.slice(0, DETAIL_CLIP)].join(` ${EVIDENCE_SEPARATOR} `),
    );
  }
  if (lines.length === 0) {
    lines.push(
      ["-", "no evidence", "This trace carries neither spans nor logs to cite."].join(` ${EVIDENCE_SEPARATOR} `),
    );
  }
  return lines;
}

/**
 * The fake's whole answer for an INCIDENT (D550/U6) — the second subject's
 * `fakeExplainDocument`, and held to the same rule: every line restates a
 * field the incident's timeline actually carries, the evidence cites only ids
 * the allowlist `incidentReferences` builds from the SAME rows, and the
 * suggestion says plainly that no model was called. A stub that answered an
 * incident with a canned string would make the RCA path CI walks a stub, which
 * is the one thing U6 forbids; this is that path with the provider removed.
 *
 * It answers from `describedIncidentRows` — the rows the PROMPT showed — and
 * not from every row the subject carries (D578): the provider removed is a
 * provider that saw the prompt and nothing else, and a fake that cited a row
 * the lanes had cut would either be dropped by validation with a note calling
 * a real row "not in this incident's timeline", or, worse, prove the allowlist
 * wider than the prompt.
 */
export function fakeIncidentDocument(incident: IncidentSubject): string {
  const rows = [...describedIncidentRows(incident.rows)].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const alerts = rows.filter((row) => row.kind === "alert");
  const changes = rows.filter((row) => row.kind === "change");
  const traces = rows.filter((row) => row.kind === "trace");
  const services = [...new Set(rows.map((row) => row.service).filter((s): s is string => s !== null))];

  const lines = [
    `${LABELS.headline}: ${incidentHeadline(incident, alerts, changes, traces)}`,
    `${LABELS.where}: ${incidentWhere(services)}`,
    `${LABELS.cause}: ${incidentCause(incident, alerts, changes, traces)}`,
  ];
  for (const line of incidentEvidence(incident, changes, alerts, traces)) {
    lines.push(`${LABELS.evidence}: ${line}`);
  }
  lines.push(
    `${LABELS.suggestion}: This deployment runs Explain in fake mode (OBSTACK_EXPLAIN_MODE=fake), so the lines ` +
      `above restate what this incident's timeline itself records and no model read them — the operator of this deployment can configure one.`,
  );
  return lines.map(oneLine).join("\n");
}

function incidentHeadline(
  incident: IncidentSubject,
  alerts: IncidentTimelineRow[],
  changes: IncidentTimelineRow[],
  traces: IncidentTimelineRow[],
): string {
  if (alerts.length) return `${alerts[0].title} is the first alert in this incident's window`;
  if (changes.length) return `No alert fired in this incident's window; ${changes[0].title} is its first change`;
  if (traces.length) return `No alert fired in this incident's window; ${traces[0].title} is its first failing trace`;
  return `This incident's window holds no alerts, changes or traces, so it shows nothing about "${incident.title}"`;
}

function incidentWhere(services: string[]): string {
  if (services.length === 0) return "Unknown — no row in this incident's window names a service.";
  return `${services.join(", ")} — the service${services.length === 1 ? "" : "s"} the window's rows name.`;
}

function incidentCause(
  incident: IncidentSubject,
  alerts: IncidentTimelineRow[],
  changes: IncidentTimelineRow[],
  traces: IncidentTimelineRow[],
): string {
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  // The changes lane carries the lead-in BAND too (D535: the hour before the
  // window, as context). Only in-window changes "share the window"; the band is
  // named separately, and its LATEST row is the one nearest the incident —
  // rows arrive ascending, so that is the last match, not the first. (A first
  // draft used `find`, which picked the EARLIEST band change while the sentence
  // said "latest" — a false sentence in the CI path, caught in review.)
  const inWindow = changes.filter((change) => change.at >= incident.startedAt);
  const band = changes.filter((change) => change.at < incident.startedAt);
  const tally =
    `${count(alerts.length, "alert")}, ${count(inWindow.length, "change")} and ${count(traces.length, "failing trace")} ` +
    `share the window ${incident.startedAt} to ${incident.windowEndIso}.`;
  const lead = band.length > 0 ? band[band.length - 1] : undefined;
  const before = lead
    ? ` The latest change before the window opened is ${lead.title} at ${lead.at}.`
    : " No change precedes the window's start.";
  const summary = incident.summary ? ` The operator wrote: "${incident.summary.slice(0, DETAIL_CLIP)}"` : "";
  return `${tally}${before}${summary}`;
}

function incidentEvidence(
  incident: IncidentSubject,
  changes: IncidentTimelineRow[],
  alerts: IncidentTimelineRow[],
  traces: IncidentTimelineRow[],
): string[] {
  // One of each kind first — a change is usually what a root cause IS — then
  // the rest in timeline order, up to the same cap the trace fake keeps. Only
  // rows with an id the allowlist will hold are cited; a row without one is
  // cited as `-`, the model's own "no id behind this line".
  const ordered = [...new Set([changes[0], alerts[0], traces[0], ...changes, ...alerts, ...traces])]
    .filter((row): row is IncidentTimelineRow => row !== undefined)
    .filter((row) => row.id !== incident.id);
  const lines: string[] = [];
  for (const row of ordered.slice(0, MAX_EVIDENCE)) {
    const grade = row.severity ? `${row.severity} · ` : "";
    lines.push(
      [
        row.id ?? "-",
        `${row.kind} · ${row.title}`,
        `${grade}${row.detail ? row.detail.slice(0, DETAIL_CLIP) : `at ${row.at}`}`,
      ].join(` ${EVIDENCE_SEPARATOR} `),
    );
  }
  if (lines.length === 0) {
    lines.push(
      ["-", "no evidence", "This incident's window holds no alert, change or trace to cite."].join(` ${EVIDENCE_SEPARATOR} `),
    );
  }
  return lines;
}
