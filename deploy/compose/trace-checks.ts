/**
 * The shared trace-completeness checks (D16/D17), extracted verbatim from
 * `smoke.ts` for S2.2's stack-on-kind acceptance: `smoke.ts` (compose, M1's
 * signed exit path) and `deploy/helm/obstack/acceptance.ts` (kind/Helm, the
 * S2.2 exit) both assert THROUGH this module, so the two paths cannot drift
 * into different definitions of "the trace landed whole". The callers differ
 * only in how they reach the stack and in what extra evidence they demand on
 * top (the K8s harness adds the D37 bundle); the cross-layer claim itself is
 * defined once, here.
 *
 * Like the facade it drives, this module resolves nothing at import time —
 * callers set OBSTACK_DATA_MODE / CLICKHOUSE_* BEFORE the first
 * `awaitWholeTrace` call, which is when `@/server/data` is imported (D13).
 */
import type { Trace } from "@/lib/types";

/** The cross-layer claim the product is built on: one trace, every layer. */
export const REQUIRED_LAYERS = ["api", "agent", "tool", "llm"] as const;

/** Ingest batches at 1s and the demo's exporters flush at 1s; spans of one trace
 *  can still land across batches, so poll until the whole trace has arrived. */
export const ARRIVAL_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Everything wrong with what the facade returned, or an empty list. */
export function problemsWith(
  traceId: string,
  trace: Trace | undefined,
  listed: Trace | undefined,
): string[] {
  if (!trace) return [`getTrace("${traceId}") returned nothing`];
  const out: string[] = [];

  const stray = trace.spans.filter((s) => s.traceId !== traceId);
  if (stray.length > 0) {
    out.push(`${stray.length} span(s) carry a trace_id other than ${traceId}`);
  }

  const layers = new Set(trace.spans.map((s) => s.layer));
  const missing = REQUIRED_LAYERS.filter((l) => !layers.has(l));
  if (missing.length > 0) {
    out.push(`missing layer(s) ${missing.join(", ")} — saw ${[...layers].join(", ") || "none"}`);
  }

  const llm = trace.spans.find((s) => s.layer === "llm");
  if (llm && !llm.llm) {
    out.push(`llm span "${llm.name}" carries no GenAI detail`);
  } else if (llm?.llm) {
    const { model, prompt, completion, inputTokens, outputTokens } = llm.llm;
    if (!model) out.push("llm span has no model");
    if (!prompt) out.push("llm span has an empty prompt");
    if (!completion) out.push("llm span has an empty completion");
    if (inputTokens <= 0 || outputTokens <= 0) {
      out.push(`llm span token counts are ${inputTokens} in / ${outputTokens} out`);
    }
  }

  // The demo's fake LLM reports a priced model, so a zero total means the D9
  // pricing path is dead — not that the call was free. Exact arithmetic is
  // covered by the ingest integration tests; this only asserts liveness.
  if (trace.costUsd <= 0) {
    out.push(`trace cost is $${trace.costUsd} — ingest priced nothing`);
  }

  const correlated = trace.logs.filter((l) => l.traceId === traceId);
  if (correlated.length === 0) {
    out.push(`no log carries trace_id ${traceId} (${trace.logs.length} log(s) on the trace)`);
  }

  if (!listed) {
    out.push(`trace resolves but does not appear in listTraces()`);
  } else {
    if (!listed.service) out.push("listed trace has no root service");
    if (listed.spanCount !== trace.spans.length) {
      out.push(
        `summary span_count ${listed.spanCount} != ${trace.spans.length} span rows — rollup did not merge`,
      );
    }
  }
  return out;
}

/** Thrown by `awaitWholeTrace` on deadline; `problems` is the last poll's list. */
export class TraceIncompleteError extends Error {
  constructor(
    traceId: string,
    timeoutMs: number,
    readonly problems: string[],
  ) {
    super(`trace ${traceId} did not land whole within ${timeoutMs / 1000}s`);
  }
}

/**
 * Poll the facade until `problemsWith` returns an empty list, then return the
 * whole trace. Throws `TraceIncompleteError` when the deadline passes first.
 */
export async function awaitWholeTrace(
  traceId: string,
  timeoutMs: number = ARRIVAL_TIMEOUT_MS,
): Promise<Trace> {
  const { getTrace, listTraces } = await import("@/server/data");

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const trace = await getTrace(traceId);
    const listed = trace ? (await listTraces()).find((t) => t.id === traceId) : undefined;
    const problems = problemsWith(traceId, trace, listed);
    if (problems.length === 0) return trace as Trace;
    if (Date.now() > deadline) {
      throw new TraceIncompleteError(traceId, timeoutMs, problems);
    }
    await sleep(POLL_MS);
  }
}
