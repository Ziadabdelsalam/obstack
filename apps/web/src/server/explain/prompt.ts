import "server-only";
import type { Trace } from "@/lib/types";
import type { ExplainPrompt } from "./types";
import { EVIDENCE_SEPARATOR, LABELS, NO_REFERENCE } from "./validate";

/**
 * What the model is given: this trace's spans and its correlated logs, and
 * nothing else. The trace arrives from `queryTrace` through the scoped
 * ClickHouse facade (D113), so the tenancy question is already answered before
 * this file sees anything.
 *
 * TWO things are deliberately withheld from the provider:
 *
 *  - `llm.prompt` and `llm.completion` — the customer's own model traffic. The
 *    shape of an LLM span (model, tokens, cost, finish reason) is what a root
 *    cause is read from; the contents are the customer's data and sending them
 *    to a third party is not something an Explain click consented to.
 *  - anything that is not on the trace. No workspace name, no account, no
 *    other trace — a summary is about the thing the user opened.
 *
 * The caps below exist because a 4,000-span trace is a bill, not an input. They
 * are stated in the prompt when they bite, so the model's answer can say it saw
 * a slice rather than quietly summarising one.
 */

const MAX_SPANS = 200;
const MAX_LOGS = 60;
const MAX_LOG_BODY = 300;

const SYSTEM = [
  "You are reading one distributed trace from an observability tool and explaining why it failed, for the engineer who owns the service.",
  "Ground every claim in the spans and logs below. If the trace does not show why something failed, say that it does not — a stated gap is useful, an invented cause is not.",
  "Cite evidence only by the exact span or log id given to you. Never invent an id; write '-' when a line has no id behind it.",
  "",
  "Answer as labelled lines, one line each, no markdown, no preamble:",
  `${LABELS.headline}: one sentence naming what failed`,
  `${LABELS.where}: the layer and service the failure happened in`,
  `${LABELS.cause}: what actually went wrong, in a few sentences`,
  `${LABELS.evidence}: <span or log id, or ${NO_REFERENCE}> ${EVIDENCE_SEPARATOR} short label ${EVIDENCE_SEPARATOR} what it shows`,
  `${LABELS.suggestion}: what to do next`,
  "",
  `Two to five ${LABELS.evidence} lines. Every other label appears exactly once.`,
].join("\n");

export function buildExplainPrompt(trace: Trace): ExplainPrompt {
  return { system: SYSTEM, user: describeTrace(trace) };
}

function describeTrace(trace: Trace): string {
  const spans = trace.spans.slice(0, MAX_SPANS);
  const logs = trace.logs.slice(0, MAX_LOGS);
  const lines = [
    `trace ${trace.id}: ${trace.method} ${trace.rootName} on ${trace.service}`,
    `status ${trace.status}, ${trace.durationMs}ms, ${trace.spanCount} spans, started ${trace.startedAt}`,
    "",
    `spans (${spans.length}${spans.length < trace.spans.length ? ` of ${trace.spans.length}, truncated` : ""}):`,
  ];
  for (const span of spans) {
    const attrs = Object.entries(span.attrs)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const llm = span.llm
      ? ` llm=${span.llm.model} in=${span.llm.inputTokens} out=${span.llm.outputTokens} finish=${span.llm.finishReason}`
      : "";
    lines.push(
      `  ${span.id} [${span.layer}] ${span.service}/${span.name} +${span.startMs}ms ${span.durationMs}ms ${span.status}` +
        `${span.statusMessage ? ` "${span.statusMessage}"` : ""}${span.pod ? ` pod=${span.pod}` : ""}` +
        `${llm}${attrs ? ` ${attrs}` : ""}`,
    );
  }
  lines.push("", `logs (${logs.length}${logs.length < trace.logs.length ? ` of ${trace.logs.length}, truncated` : ""}):`);
  for (const log of logs) {
    lines.push(
      `  ${log.id} +${log.atMs}ms ${log.severity} ${log.pod}/${log.container}: ${log.body.slice(0, MAX_LOG_BODY)}`,
    );
  }
  if (trace.k8sEvents?.length) {
    lines.push("", "cluster events:");
    for (const event of trace.k8sEvents) {
      lines.push(`  +${event.atMs}ms ${event.severity} ${event.kind} ${event.pod}: ${event.label}`);
    }
  }
  return lines.join("\n");
}
