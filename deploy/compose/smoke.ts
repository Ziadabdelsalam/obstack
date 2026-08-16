/**
 * Phase 1 acceptance assertion (D16/D17).
 *
 * Drives the real web facade — `apps/web/src/server/data.ts`, the same module the app
 * renders from — against the trace the demo agent just emitted. No Next server,
 * no throwaway API route: `--conditions react-server` satisfies the `server-only`
 * guard and tsx resolves the `@/` paths.
 *
 * Normally invoked by `smoke.sh`; standalone:
 *   npx tsx --conditions react-server deploy/compose/smoke.ts <trace_id>
 */
import type { Trace } from "@/lib/types";

/** The cross-layer claim the product is built on: one trace, every layer. */
const REQUIRED_LAYERS = ["api", "agent", "tool", "llm"] as const;

/** Ingest batches at 1s and the demo's exporters flush at 1s; spans of one trace
 *  can still land across batches, so poll until the whole trace has arrived. */
const ARRIVAL_TIMEOUT_MS = 30_000;
const POLL_MS = 1_000;

function fail(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Everything wrong with what the facade returned, or an empty list. */
function problemsWith(traceId: string, trace: Trace | undefined, listed: Trace | undefined): string[] {
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

async function main(): Promise<void> {
  const traceId = process.argv[2];
  if (!traceId) fail("usage: smoke.ts <trace_id>");

  // The facade resolves its mode at import time (D13), so the env comes first.
  process.env.OBSTACK_DATA_MODE = "live";
  process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
  process.env.CLICKHOUSE_USER ??= "obstack_web";
  process.env.CLICKHOUSE_PASSWORD ??= "obstack_web_dev";

  const { getTrace, listTraces } = await import("@/server/data");

  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  let trace: Trace | undefined;
  let problems: string[] = [];
  for (;;) {
    trace = await getTrace(traceId);
    const listed = trace ? (await listTraces()).find((t) => t.id === traceId) : undefined;
    problems = problemsWith(traceId, trace, listed);
    if (problems.length === 0) break;
    if (Date.now() > deadline) {
      for (const p of problems) console.error(`smoke:   - ${p}`);
      fail(`trace ${traceId} did not land whole within ${ARRIVAL_TIMEOUT_MS / 1000}s`);
    }
    await sleep(POLL_MS);
  }

  const whole = trace as Trace;
  const byLayer = REQUIRED_LAYERS.map(
    (l) => `${l}=${whole.spans.filter((s) => s.layer === l).length}`,
  ).join(" ");
  const llm = whole.spans.find((s) => s.layer === "llm")?.llm;
  console.log(`smoke: trace ${traceId} lists and resolves through the facade`);
  console.log(`smoke:   ${whole.service} · ${whole.rootName} · ${whole.durationMs}ms · ${whole.spans.length} spans (${byLayer})`);
  console.log(
    `smoke:   llm ${llm?.model} · ${llm?.inputTokens}+${llm?.outputTokens} tokens · $${whole.costUsd.toFixed(6)}`,
  );
  console.log(`smoke:   ${whole.logs.filter((l) => l.traceId === traceId).length} correlated log(s)`);
  console.log("smoke: PASS");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
