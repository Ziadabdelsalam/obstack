/**
 * S2.4's rendering proof (D84): the SDK sample traces, read back through the
 * shipped query layer — `apps/web/src/server/data.ts`, the same facade the
 * product renders from (D17). Everything `sdk-evidence.sh` asserts before this
 * runs is SQL against ClickHouse; this file is the other half of that claim,
 * because a row that is in the table and a trace the app can render are not the
 * same statement.
 *
 * Three samples since S4.3 (D307): the Python one, the TypeScript one on `ai` 6,
 * and its twin on `ai` 7 whose `generateText` call passes no telemetry option at
 * all. Nothing below special-cases the twin — that is the point. It is asserted
 * by exactly the same predicates as its sibling, because "the ai@7 sample
 * produces the four-layer trace" is a claim about the trace and not about the
 * harness being lenient.
 *
 * Normally invoked by `sdk-evidence.sh`; standalone, from the repo root:
 *   npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
 *     deploy/compose/sdk-checks.ts <py-trace-id> <ts-trace-id> <ai7-trace-id>
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
 * `REQUIRED_LAYERS` and `DEMO_WORKSPACE` are imported rather than restated: one
 * definition of the cross-layer claim, and one of the workspace the demo stack
 * writes under, across smoke, Helm acceptance and this harness.
 */
import type { Span, Trace } from "@/lib/types";
import { DEMO_WORKSPACE, REQUIRED_LAYERS } from "./trace-checks";

/** The samples' exporters batch at 1s (py) and 5s (js), and ingest batches on
 *  top of that, so one poll proves nothing about a trace that is still in
 *  flight. Same shape as `trace-checks.ts`' own wait, with this file's checks. */
const ARRIVAL_TIMEOUT_MS = 45_000;
const POLL_MS = 1_000;

/**
 * D308/D301: how the Responses-API llm span is told apart from the two chat
 * spans beside it, and what it has to carry once found.
 *
 * The discriminator is `gen_ai.response.finish_reasons`. The Responses API has
 * no `finish_reason` in its schema at all, so obstack-js records the response
 * `status` there verbatim (D301) — `completed` for a turn that finished, which
 * neither chat leg can produce: both of those report OpenAI's own `stop`. It is
 * read off the attributes Map rather than `span.llm.finishReason`, because the
 * facade maps the open-ended OTel value onto a closed four-value union for the
 * UI (`adapters.ts`, unknown → `stop`) and `completed` is not in it. That
 * mapping is correct for rendering and useless as an identity, so this reads
 * the wire value the Map still holds.
 */
const RESPONSES_STATUS = "completed";
const RESPONSES_MODEL = "gpt-4o-mini";
/** The sample sends `input` as a bare string, which obstack-js serialises into
 *  the same JSON message array every other path uses (D300) — so the prompt is
 *  an array, and its one element is the user turn. */
const RESPONSES_PROMPT_SHAPE = /^\[\s*\{/;
const RESPONSES_PROMPT_ROLE = '"role":"user"';

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
  /**
   * Whether one of this trace's llm spans must be an OpenAI Responses API call
   * (D308). True for both TypeScript samples, which each make one; false for
   * the Python sample, whose SDK does not instrument that surface.
   */
  requireResponsesSpan: boolean;
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
 * list. Every llm span is checked, not the first one: each TypeScript sample
 * lands three (the Vercel-AI leg, the openai chat leg and the openai Responses
 * leg — D77(e), D308), and a check that looked only at `find()` would pass
 * while one of the three mechanisms shipped an empty prompt.
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

  if (sample.requireResponsesSpan) out.push(...responsesProblems(label, llmSpans));

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

/** The wire finish reason, as the SDK sent it — see `RESPONSES_STATUS`. */
function finishReasonsOf(span: Span): string {
  return String(span.attrs["gen_ai.response.finish_reasons"] ?? "");
}

/**
 * The Responses API call, found among the trace's llm spans and then held to
 * the same D8 set as every other llm span — value by value, because the whole
 * point of D308 is that a second instrumented OpenAI surface produces a span
 * indistinguishable in completeness from the first.
 *
 * Requiring EXACTLY one match is part of the assertion rather than tidiness: if
 * a chat span ever started reporting `completed` too, a `find()` here would go
 * on passing while the harness had quietly stopped knowing which span it was
 * looking at.
 */
function responsesProblems(label: string, llmSpans: Span[]): string[] {
  const matches = llmSpans.filter((s) => finishReasonsOf(s).includes(RESPONSES_STATUS));
  if (matches.length !== 1) {
    const seen = llmSpans
      .map((s) => `${s.name} → ${finishReasonsOf(s) || "«no finish reason»"}`)
      .join("; ");
    return [
      `${label}: expected exactly one llm span whose gen_ai.response.finish_reasons carries ` +
        `"${RESPONSES_STATUS}" (the Responses call, D301) — found ${matches.length} among ` +
        `${llmSpans.length} llm span(s): ${seen || "none"}`,
    ];
  }

  const span = matches[0];
  if (!span) return [`${label}: the Responses span vanished between filter and read`];
  const at = `${label}: the Responses span "${span.name}"`;
  const out: string[] = [];
  const attr = (key: string): string => String(span.attrs[key] ?? "");

  if (attr("gen_ai.system") !== "openai") {
    out.push(`${at} has gen_ai.system "${attr("gen_ai.system")}", not "openai"`);
  }
  for (const key of ["gen_ai.request.model", "gen_ai.response.model"]) {
    if (attr(key) !== RESPONSES_MODEL) {
      out.push(`${at} has ${key} "${attr(key)}", not "${RESPONSES_MODEL}"`);
    }
  }

  const detail = span.llm;
  if (!detail) {
    out.push(`${at} carries no GenAI detail`);
    return out;
  }
  if (!RESPONSES_PROMPT_SHAPE.test(detail.prompt) || !detail.prompt.includes(RESPONSES_PROMPT_ROLE)) {
    out.push(
      `${at} prompt is not the D300 message array with a user element: ` +
        `${JSON.stringify(detail.prompt.slice(0, 120))}`,
    );
  }
  if (detail.completion.length === 0) out.push(`${at} has an empty completion`);
  if (detail.inputTokens <= 0 || detail.outputTokens <= 0) {
    out.push(`${at} token counts are ${detail.inputTokens} in / ${detail.outputTokens} out`);
  }
  return out;
}

/** Poll the facade for every sample until all of them are clean, or fail. */
async function awaitSamples(samples: Sample[]): Promise<Map<string, Trace>> {
  // The explicit entry (D113): both samples export under `ok_dev_local`, the
  // seeded key row that resolves to the one workspace `DEMO_WORKSPACE` names —
  // there is no ambient workspace the facade could resolve on this harness's
  // behalf.
  const { dataForWorkspace } = await import("@/server/data");
  const data = dataForWorkspace(DEMO_WORKSPACE);

  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  for (;;) {
    const resolved = new Map<string, Trace>();
    const problems: string[] = [];
    for (const sample of samples) {
      const trace = await data.getTrace(sample.traceId);
      const search = trace ? await data.searchTraces() : undefined;
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
  const [pyTraceId, tsTraceId, ai7TraceId] = process.argv.slice(2);
  if (!pyTraceId || !tsTraceId || !ai7TraceId) {
    fail("usage: sdk-checks.ts <py-trace-id> <ts-trace-id> <ai7-trace-id>");
  }

  // The facade resolves its mode at import time (D13), so the env comes first —
  // same defaults `smoke.ts` uses, same read-only ClickHouse user the app has.
  process.env.OBSTACK_DATA_MODE = "live";
  process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:8123";
  process.env.CLICKHOUSE_USER ??= "obstack_web";
  process.env.CLICKHOUSE_PASSWORD ??= "obstack_web_dev";

  const samples: Sample[] = [
    { label: "sdk-sample-py", traceId: pyTraceId, requireCorrelatedLog: true, requireResponsesSpan: false },
    { label: "sdk-sample-ts", traceId: tsTraceId, requireCorrelatedLog: false, requireResponsesSpan: true },
    {
      label: "sdk-sample-ts-ai7",
      traceId: ai7TraceId,
      requireCorrelatedLog: false,
      requireResponsesSpan: true,
    },
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
    if (sample.requireResponsesSpan) {
      const responses = trace.spans
        .filter((s) => s.layer === "llm")
        .find((s) => finishReasonsOf(s).includes(RESPONSES_STATUS));
      console.log(
        `sdk-checks:   Responses span "${responses?.name}" · gen_ai.system ${String(responses?.attrs["gen_ai.system"])}` +
          ` · finish_reasons ${finishReasonsOf(responses as Span)} · ${responses?.llm?.inputTokens}+${responses?.llm?.outputTokens} tokens (D308/D301)`,
      );
    }
    console.log(
      `sdk-checks:   $${trace.costUsd.toFixed(6)} · ${trace.logs.filter((l) => l.traceId === sample.traceId).length} correlated log(s)${sample.requireCorrelatedLog ? "" : " (not required — D84)"}`,
    );
  }
  console.log("sdk-checks: PASS");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
