/**
 * S2.4's rendering proof (D84): the two SDK sample traces, read back through
 * the shipped query layer — `apps/web/src/server/data.ts`, the same facade the
 * product renders from (D17). Everything `sdk-evidence.sh` asserts before this
 * runs is SQL against ClickHouse; this file is the other half of that claim,
 * because a row that is in the table and a trace the app can render are not the
 * same statement.
 *
 * Normally invoked by `sdk-evidence.sh`; standalone, from the repo root:
 *   npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
 *     deploy/compose/sdk-checks.ts <py-trace-id> <ts-trace-id>
 *
 * Why this is not `smoke.ts`/`trace-checks.ts`' `problemsWith` (D84): that
 * predicate is M1's signed compose exit and S2.2's Helm acceptance, and it
 * demands a correlated log on every trace it is given. obstack-js ships a
 * LoggerProvider but no logging-framework bridge this sprint, so the TypeScript
 * sample emits no logs by design — asserting one would either fail honestly or
 * push scope into obstack-js. The SDK exit clause is the four-layer trace with
 * GenAI attributes; correlated logs are asserted where they are real, on the
 * Python sample, which gets them from the root-logger handler `init()` installs.
 *
 * `REQUIRED_LAYERS` is imported rather than restated: one definition of the
 * cross-layer claim across smoke, Helm acceptance and this harness. Nothing in
 * `trace-checks.ts` is edited — it is a signed evidence path (S2.4 scope fence).
 */
import type { Trace } from "@/lib/types";
import { REQUIRED_LAYERS } from "./trace-checks";

/** The samples' exporters batch at 1s (py) and 5s (js), and ingest batches on
 *  top of that, so one poll proves nothing about a trace that is still in
 *  flight. Same shape as `trace-checks.ts`' own wait, with this file's checks. */
const ARRIVAL_TIMEOUT_MS = 45_000;
const POLL_MS = 1_000;

interface Sample {
  /** How the sample is named in output and in the evidence document. */
  label: string;
  traceId: string;
  /**
   * Whether a log carrying this trace id must exist. True for the Python
   * sample only — see the file header; obstack-js has no logging bridge, and a
   * check that demanded one would be asserting a feature nobody built (D84).
   */
  requireCorrelatedLog: boolean;
}

function fail(message: string): never {
  console.error(`sdk-checks: ${message}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Everything wrong with what the facade returned for one sample, or an empty
 * list. Every llm span is checked, not the first one: the TypeScript sample
 * lands two (the Vercel-AI leg and the openai leg, D77(e)), and a check that
 * looked only at `find()` would pass while one of the two mechanisms shipped an
 * empty prompt.
 */
function problemsWith(sample: Sample, trace: Trace | undefined, listed: Trace | undefined): string[] {
  const { traceId, label } = { traceId: sample.traceId, label: sample.label };
  if (!trace) return [`${label}: getTrace("${traceId}") returned nothing`];
  const out: string[] = [];

  const stray = trace.spans.filter((s) => s.traceId !== traceId);
  if (stray.length > 0) {
    out.push(`${label}: ${stray.length} span(s) carry a trace_id other than ${traceId}`);
  }

  const layers = new Set(trace.spans.map((s) => s.layer));
  const missing = REQUIRED_LAYERS.filter((l) => !layers.has(l));
  if (missing.length > 0) {
    out.push(`${label}: missing layer(s) ${missing.join(", ")} — saw ${[...layers].join(", ") || "none"}`);
  }

  const llmSpans = trace.spans.filter((s) => s.layer === "llm");
  if (llmSpans.length === 0) {
    out.push(`${label}: no llm span on the trace`);
  }
  for (const span of llmSpans) {
    if (!span.llm) {
      out.push(`${label}: llm span "${span.name}" carries no GenAI detail`);
      continue;
    }
    const { model, prompt, completion, inputTokens, outputTokens } = span.llm;
    if (!model) out.push(`${label}: llm span "${span.name}" has no model`);
    // The dedicated columns, reached the way a reader must reach them
    // (D8-AMENDMENT / carry-forward 4): the facade fills these from
    // obstack.spans' prompt/completion columns, never from the attributes Map,
    // which sdk-evidence.sh separately proves holds neither the keys nor the
    // content.
    if (!prompt) out.push(`${label}: llm span "${span.name}" has an empty prompt`);
    if (!completion) out.push(`${label}: llm span "${span.name}" has an empty completion`);
    if (inputTokens <= 0 || outputTokens <= 0) {
      out.push(`${label}: llm span "${span.name}" token counts are ${inputTokens} in / ${outputTokens} out`);
    }
  }

  // Both samples' fakes report gpt-4o-mini, which ingest prices, so a zero
  // total means the D9 pricing path is dead — not that the call was free. The
  // SDKs carry no pricing logic at all, which is exactly why this is worth
  // asserting from the SDK side.
  if (trace.costUsd <= 0) {
    out.push(`${label}: trace cost is $${trace.costUsd} — ingest priced nothing`);
  }

  if (sample.requireCorrelatedLog) {
    const correlated = trace.logs.filter((l) => l.traceId === traceId);
    if (correlated.length === 0) {
      out.push(`${label}: no log carries trace_id ${traceId} (${trace.logs.length} log(s) on the trace)`);
    }
  }

  if (!listed) {
    out.push(`${label}: trace resolves but does not appear in searchTraces()`);
  } else {
    // The listed row is what the traces page renders: a trace whose root span
    // is the sample's own api span names the service, and one whose root is
    // missing does not. The evidence run therefore never pins a traceparent
    // from outside — it lets each sample be the root of its own trace.
    if (!listed.service) out.push(`${label}: listed trace has no root service`);
    if (listed.spanCount !== trace.spans.length) {
      out.push(
        `${label}: summary span_count ${listed.spanCount} != ${trace.spans.length} span rows — rollup did not merge`,
      );
    }
  }
  return out;
}

/** Poll the facade for every sample until all of them are clean, or fail. */
async function awaitSamples(samples: Sample[]): Promise<Map<string, Trace>> {
  const { getTrace, searchTraces } = await import("@/server/data");

  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  for (;;) {
    const resolved = new Map<string, Trace>();
    const problems: string[] = [];
    for (const sample of samples) {
      const trace = await getTrace(sample.traceId);
      const search = trace ? await searchTraces() : undefined;
      const listed = search?.traces.find((t) => t.id === sample.traceId);
      const sampleProblems = problemsWith(sample, trace, listed);
      if (sampleProblems.length === 0 && trace) resolved.set(sample.label, trace);
      problems.push(...sampleProblems);
    }
    if (problems.length === 0) return resolved;
    if (Date.now() > deadline) {
      for (const p of problems) console.error(`sdk-checks:   - ${p}`);
      fail(`the sample traces did not render whole within ${ARRIVAL_TIMEOUT_MS / 1000}s`);
    }
    await sleep(POLL_MS);
  }
}

async function main(): Promise<void> {
  const [pyTraceId, tsTraceId] = process.argv.slice(2);
  if (!pyTraceId || !tsTraceId) fail("usage: sdk-checks.ts <py-trace-id> <ts-trace-id>");

  // The facade resolves its mode at import time (D13), so the env comes first —
  // same defaults `smoke.ts` uses, same read-only ClickHouse user the app has.
  process.env.OBSTACK_DATA_MODE = "live";
  process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
  process.env.CLICKHOUSE_USER ??= "obstack_web";
  process.env.CLICKHOUSE_PASSWORD ??= "obstack_web_dev";

  const samples: Sample[] = [
    { label: "sdk-sample-py", traceId: pyTraceId, requireCorrelatedLog: true },
    { label: "sdk-sample-ts", traceId: tsTraceId, requireCorrelatedLog: false },
  ];

  const traces = await awaitSamples(samples);
  for (const sample of samples) {
    const trace = traces.get(sample.label) as Trace;
    const byLayer = REQUIRED_LAYERS.map(
      (l) => `${l}=${trace.spans.filter((s) => s.layer === l).length}`,
    ).join(" ");
    const llm = trace.spans.filter((s) => s.layer === "llm").map((s) => s.llm);
    console.log(`sdk-checks: ${sample.label} · trace ${sample.traceId} lists and resolves through the facade`);
    console.log(
      `sdk-checks:   ${trace.service} · ${trace.rootName} · ${trace.durationMs}ms · ${trace.spans.length} spans (${byLayer})`,
    );
    for (const detail of llm) {
      console.log(
        `sdk-checks:   llm ${detail?.model} · ${detail?.inputTokens}+${detail?.outputTokens} tokens · prompt ${detail?.prompt.length}B · completion ${detail?.completion.length}B`,
      );
    }
    console.log(
      `sdk-checks:   $${trace.costUsd.toFixed(6)} · ${trace.logs.filter((l) => l.traceId === sample.traceId).length} correlated log(s)${sample.requireCorrelatedLog ? "" : " (not required — D84)"}`,
    );
  }
  console.log("sdk-checks: PASS");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
