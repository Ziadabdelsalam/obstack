import "server-only";
import type { LogRecord, Span, Trace } from "@/lib/types";
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
 * field this trace actually carries, and the suggestion says plainly that no
 * model was called. A deployment running fake mode therefore cannot show a
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

  async *stream(_prompt, trace) {
    const document = fakeExplainDocument(trace);
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
