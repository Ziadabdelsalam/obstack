import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after } from "node:test";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { traceAgent } from "./helpers";
import { D8, D8_LLM_ATTRIBUTES } from "./testing/d8-contract";
import { captureSpans } from "./testing/harness";
import { VercelAiTranslationProcessor } from "./vercel-ai";
import { registerVercelAiV7Integration } from "./vercel-ai-v7";

/**
 * The `ai` 7 leg, driven against the REAL library — `ai7` in this package's
 * devDependencies is an npm alias for `ai@7.0.85`, installed side by side with
 * the `ai@6` the suite next door uses. A telemetry integration tested against a
 * hand-written stand-in for `ai`'s dispatcher would prove that the stand-in
 * calls the hooks, which is not the question (S2.0 L1). The question is whether
 * a real `generateText` on a real `ai` 7 produces obstack's llm span, and only
 * the real dispatcher can answer it.
 *
 * The two legs are also deliberately live TOGETHER here: the v5/6 translation
 * processor is registered on the same provider as the v7 integration, which is
 * the arrangement `init()` produces in a real application. One of these tests
 * runs an `ai@6` call through that arrangement and counts llm spans, because
 * "both registered" is exactly the shape in which a double emission would ship
 * unnoticed.
 *
 * Every model below is a structural `LanguageModelV4` written out by hand
 * rather than taken from `ai/test`, for the same reason `vercel-ai.test.ts`
 * does it: `ai/test`'s mocks drag `msw` in as a transitive dev dependency.
 */

const spans = captureSpans(new VercelAiTranslationProcessor());

// The door, opened exactly as `init()` opens it. Before any `ai` call, but not
// because it has to be: the integrations array is read per operation, so this
// would work after `ai` had already been imported and used.
registerVercelAiV7Integration();

const MODEL_ID = "gpt-4o-mini";
const RESPONSE_MODEL_ID = "gpt-4o-mini-2024-07-18";
const ANSWER = "Restart the ingest pod, then re-check the collector queue.";
const SYSTEM_PROMPT = "You are the obstack test agent.";
const QUESTION = "What should I try first?";
const INPUT_TOKENS = 31;
const OUTPUT_TOKENS = 12;

/* eslint-disable @typescript-eslint/no-var-requires */
const ai7 = require("ai7") as {
  generateText(options: Record<string, unknown>): Promise<{ text: string; steps: unknown[] }>;
  streamText(options: Record<string, unknown>): { textStream: AsyncIterable<string> };
  stepCountIs(count: number): unknown;
  tool(definition: Record<string, unknown>): unknown;
  jsonSchema(schema: Record<string, unknown>): unknown;
};

const ai7Version: string = JSON.parse(
  readFileSync(path.join(path.dirname(require.resolve("ai7")), "..", "package.json"), "utf8"),
).version;

/** A single-turn model: one text part, known usage, known response model. */
const model = {
  specificationVersion: "v4",
  provider: "openai.chat",
  modelId: MODEL_ID,
  supportedUrls: {},
  async doGenerate() {
    return {
      content: [{ type: "text", text: ANSWER }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: INPUT_TOKENS },
        outputTokens: { total: OUTPUT_TOKENS },
      },
      warnings: [],
      response: { modelId: RESPONSE_MODEL_ID },
    };
  },
  async doStream() {
    return {
      stream: new ReadableStream({
        start(controller: ReadableStreamDefaultController<unknown>) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: "1" });
          controller.enqueue({ type: "text-delta", id: "1", delta: ANSWER });
          controller.enqueue({ type: "text-end", id: "1" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: "stop" },
            usage: { inputTokens: { total: INPUT_TOKENS }, outputTokens: { total: OUTPUT_TOKENS } },
          });
          controller.close();
        },
      }),
    };
  },
};

after(async () => {
  await spans.shutdown();
});

/** Spans finished since the last call. `node:test` runs the tests in a file in
 *  order, so a cursor is enough to keep each test's assertions about its own
 *  call rather than about everything that has run so far. */
let cursor = 0;
function since(): ReadableSpan[] {
  const all = spans.finishedSpans();
  const fresh = all.slice(cursor);
  cursor = all.length;
  return fresh;
}

/** What ingest classifies as the llm layer: any span carrying a `gen_ai.*`
 *  attribute (`services/ingest/internal/mapping/mapping.go`). Counting by that
 *  rule rather than by span name is the point — a second llm span under a
 *  different name would still double the layer and the cost column. */
const llmSpans = (list: ReadableSpan[]): ReadableSpan[] =>
  list.filter((span) => Object.keys(span.attributes).some((key) => key.startsWith("gen_ai.")));

test("a v7 generateText produces exactly one complete llm span", async () => {
  const result = await ai7.generateText({ model, system: SYSTEM_PROMPT, prompt: QUESTION });
  assert.equal(result.text, ANSWER, "generateText did not run — nothing below would mean anything");

  const fresh = since();
  const found = llmSpans(fresh);
  assert.equal(
    found.length,
    1,
    `ai ${ai7Version} produced ${found.length} llm spans (saw: ${fresh.map((s) => s.name).join(", ") || "none"}). ai 7 emits no OTel spans of its own, so this span exists only if the integration registered by init() was actually called.`,
  );
  const span = found[0]!;

  const missing = D8_LLM_ATTRIBUTES.filter((name) => span.attributes[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `the v7 llm span is missing ${missing.join(", ")}; ingest reads these names literally, so the span would land with no model, no tokens and no cost`,
  );

  // Value by value against what the stub actually returned — a completeness
  // check alone would pass on a span full of the wrong numbers.
  assert.equal(span.attributes[D8.system], "openai", "ai reports openai.chat; D82 wants the bare vendor");
  assert.equal(span.attributes[D8.requestModel], MODEL_ID);
  assert.equal(span.attributes[D8.responseModel], RESPONSE_MODEL_ID);
  assert.equal(span.attributes[D8.completion], ANSWER);
  assert.equal(span.attributes[D8.inputTokens], INPUT_TOKENS);
  assert.equal(span.attributes[D8.outputTokens], OUTPUT_TOKENS);
  assert.deepEqual(span.attributes[D8.finishReasons], ["stop"]);

  assert.equal(span.name, `chat ${MODEL_ID}`);
  assert.equal(span.kind, SpanKind.CLIENT);
  assert.equal(span.status.code, SpanStatusCode.UNSET);
});

test("the system prompt survives v7's relocation as the leading gen_ai.prompt element", async () => {
  // v7 hands the system text over as `instructions`, a SIBLING of `messages`
  // rather than `messages[0]`. A verbatim JSON.stringify of `messages` would
  // drop it silently — the prompt column would simply be missing half the
  // conversation, with nothing going red. D300 folds it back in at the front.
  await ai7.generateText({ model, system: SYSTEM_PROMPT, prompt: QUESTION });
  const span = llmSpans(since())[0]!;

  const prompt = JSON.parse(String(span.attributes[D8.prompt])) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(prompt), "gen_ai.prompt is not a JSON array");
  assert.deepEqual(prompt[0], { role: "system", content: SYSTEM_PROMPT });
  assert.equal(prompt.length, 2);
  assert.equal(prompt[1]!["role"], "user");
});

test("two llm spans in one agent step are both children of the agent span", async () => {
  // PROVEN RED FIRST. The wrapper opens its span against `context.active()`;
  // with the parent forced to ROOT_CONTEXT in vercel-ai-v7.ts the call still
  // succeeds, the spans still carry every D8 attribute, and every other test in
  // this file still passes — only this assertion goes red, with
  // `undefined !== <the agent span id>`. That is the whole reason this test
  // exists: the join is the one property of the v7 path that fails silently and
  // costs the four-layer trace its shape, turning each llm span into its own
  // root beside the agent step instead of underneath it.
  let step = 0;
  const toolModel = {
    ...model,
    async doGenerate() {
      step += 1;
      if (step === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: "tc1",
              toolName: "lookup",
              input: JSON.stringify({ query: "ingest" }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } },
          warnings: [],
          response: { modelId: RESPONSE_MODEL_ID },
        };
      }
      return {
        content: [{ type: "text", text: ANSWER }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 20 }, outputTokens: { total: 7 } },
        warnings: [],
        response: { modelId: RESPONSE_MODEL_ID },
      };
    },
  };

  await traceAgent("answer_question", async () =>
    ai7.generateText({
      model: toolModel,
      prompt: QUESTION,
      tools: {
        lookup: ai7.tool({
          description: "look up a runbook",
          inputSchema: ai7.jsonSchema({
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          }),
          execute: async (input: { query: string }) => `runbook for ${input.query}`,
        }),
      },
      stopWhen: ai7.stepCountIs(3),
    }),
  );

  const fresh = since();
  const found = llmSpans(fresh);
  assert.equal(
    found.length,
    2,
    `a two-step tool round should be two llm spans, one per provider call; saw ${found.length} (${fresh.map((s) => s.name).join(", ")})`,
  );

  const agent = fresh.filter((span) => span.name === "agent.answer_question");
  assert.equal(agent.length, 1, "the traceAgent span did not end");
  const agentId = agent[0]!.spanContext().spanId;

  for (const span of found) {
    assert.equal(
      span.parentSpanContext?.spanId,
      agentId,
      "an llm span is not a child of the surrounding traceAgent span; the trace renders as separate roots instead of a four-layer tree",
    );
  }
});

test("a streaming call produces no span at all and still streams", async () => {
  // D259: streaming is out this release, and the honest shape of "out" is no
  // span. The usage numbers arrive inside the stream, so a span opened here
  // would carry zero tokens and ingest would price it at $0 — a wrong cost
  // rather than a missing one. `ai` invokes the same wrapper for doStream with
  // nothing in its options to say so, which is why onStart's operationId is
  // recorded at all.
  const stream = ai7.streamText({ model, prompt: QUESTION });
  let streamed = "";
  for await (const chunk of stream.textStream) streamed += chunk;
  assert.equal(streamed, ANSWER, "the stream was not consumed — a zero-span assertion below would be vacuous");

  const fresh = since();
  assert.deepEqual(
    llmSpans(fresh).map((span) => span.name),
    [],
    "a streaming call produced an llm span",
  );
});

test("telemetry: { isEnabled: false } is honoured — ai never calls the integration", async () => {
  // Not obstack's switch: `ai`'s own dispatcher short-circuits before any
  // integration is consulted, so the opt-out is one knob for every integration
  // an app has registered rather than an obstack-specific environment variable.
  const result = await ai7.generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: QUESTION,
    telemetry: { isEnabled: false },
  });
  assert.equal(result.text, ANSWER);

  assert.deepEqual(
    llmSpans(since()).map((span) => span.name),
    [],
    "a call with telemetry disabled still produced an llm span",
  );
});

test("a failing provider call ends the span ERROR and re-throws the error untouched", async () => {
  const boom = new Error("the provider refused the request");
  const failing = {
    ...model,
    async doGenerate(): Promise<never> {
      throw boom;
    },
  };

  // Identity, not just the message: an observability layer that replaces the
  // application's exception with its own has broken the thing it observes.
  await assert.rejects(
    () => ai7.generateText({ model: failing, prompt: QUESTION, maxRetries: 0 }),
    (error: unknown) => error === boom,
  );

  const found = llmSpans(since());
  assert.equal(found.length, 1, "the failed call left no span; a failure is evidence, not a reason to be silent");
  const span = found[0]!;
  assert.equal(span.status.code, SpanStatusCode.ERROR);
  assert.equal(span.status.message, boom.message);
  assert.ok(span.ended, "the span was left open");
  // The request half is still there — a span that records only the failure
  // cannot tell you which model or which prompt failed.
  assert.equal(span.attributes[D8.requestModel], MODEL_ID);
  assert.equal(span.attributes[D8.responseModel], undefined);
});

test("an ai@6 call still produces exactly one llm span with the v7 integration registered", async () => {
  // The double-emission guard. Both legs are registered on this provider, as
  // init() registers them in a real app. They are mutually exclusive by
  // measurement — the v5/6 processor keys on `ai.operationId`, which ai 7 never
  // sets, and the v7 integration is only ever called by ai 7's dispatcher — but
  // "mutually exclusive by measurement" is a claim, and this is the measurement.
  const { generateText } = require("ai") as typeof import("ai");
  const v6Model = {
    specificationVersion: "v2",
    provider: "openai.chat",
    modelId: MODEL_ID,
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [{ type: "text", text: ANSWER }],
        finishReason: "stop",
        usage: { inputTokens: INPUT_TOKENS, outputTokens: OUTPUT_TOKENS, totalTokens: 43 },
        warnings: [],
        response: { modelId: RESPONSE_MODEL_ID },
      };
    },
  };

  const result = await generateText({
    model: v6Model as never,
    system: SYSTEM_PROMPT,
    prompt: QUESTION,
    experimental_telemetry: { isEnabled: true },
  });
  assert.equal(result.text, ANSWER);

  const fresh = since();
  const found = llmSpans(fresh);
  assert.equal(
    found.length,
    1,
    `an ai@6 call produced ${found.length} llm spans (${found.map((s) => s.name).join(", ")}); two would double the llm layer and the cost column for one model call`,
  );
  v6Prompt = String(found[0]!.attributes[D8.prompt]);
});

/** The v6 wire form for the same conversation, captured by the test above so
 *  the parity check below compares two measured strings rather than one
 *  measured string and one remembered one. */
let v6Prompt = "";

test("D300 parity: the same conversation serialises the same way on v6 and v7", async () => {
  assert.notEqual(v6Prompt, "", "the ai@6 prompt was not captured — the test above must run first");

  await ai7.generateText({ model, system: SYSTEM_PROMPT, prompt: QUESTION });
  const v7Prompt = String(llmSpans(since())[0]!.attributes[D8.prompt]);

  const v6 = JSON.parse(v6Prompt) as unknown[];
  const v7 = JSON.parse(v7Prompt) as unknown[];

  // Byte-equal: the system element. This is the half D300 exists for — v7
  // relocated the system text out of the messages array, and folding it back in
  // at the front reproduces v6's `ai.prompt.messages` element exactly.
  assert.equal(
    JSON.stringify(v7[0]),
    JSON.stringify(v6[0]),
    "the leading system element is not byte-identical to the v6 form",
  );
  assert.deepEqual(v7[0], { role: "system", content: SYSTEM_PROMPT });
  assert.equal(v6.length, v7.length, "the two forms carry a different number of messages");

  // NOT byte-equal, measured and recorded: the user turn. `ai` normalises
  // messages at two different points on the two majors — v6's
  // `ai.prompt.messages` is the CONVERTED provider prompt, where a text-only
  // user turn's content is `[{type:"text",text:…}]`, while v7's integration
  // event carries the STANDARDISED prompt, where the same turn's content is
  // the bare string. Both are `ai`'s own serialisation of the same
  // conversation, passed through untouched by D300 ("array elements are
  // serialized untouched"); the difference is upstream's, not obstack's, and
  // nothing in ingest reads inside the prompt column. Pinned rather than
  // asserted away, so a change to either normalisation is visible here.
  assert.deepEqual(v6[1], { role: "user", content: [{ type: "text", text: QUESTION }] });
  assert.deepEqual(v7[1], { role: "user", content: QUESTION });
});

test("the integration is on the global registry ai 7 reads, exactly once", () => {
  // The door itself. `init()` pushes one object onto this array and never
  // imports `ai` to do it; if the key ever changes upstream, every test above
  // goes red for a reason that reads like "no span", so this one names it.
  const registry = (globalThis as unknown as Record<string, unknown>)[
    "AI_SDK_TELEMETRY_INTEGRATIONS"
  ];
  assert.ok(Array.isArray(registry), "ai 7's integration registry is not an array on globalThis");
  const ours = registry.filter(
    (entry) => (entry as { constructor?: { name?: string } })?.constructor?.name === "ObstackVercelAiIntegration",
  );
  assert.equal(ours.length, 1, "obstack registered its v7 integration more or less than once");
});
