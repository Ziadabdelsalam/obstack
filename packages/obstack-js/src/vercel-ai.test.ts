import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { D8, D8_LLM_ATTRIBUTES } from "./testing/d8-contract";
import { captureSpans } from "./testing/harness";
import { VercelAiTranslationProcessor } from "./vercel-ai";

/**
 * The Vercel-AI leg is a translation, so this suite has two jobs and keeps them
 * apart:
 *
 *   1. Pin what `ai` actually emits. Every literal `vercel-ai.ts` reads is
 *      asserted against the INSTALLED version by running a real generateText —
 *      not against documentation, and not against what it emitted a major ago.
 *      When `ai` renames one of these, this is what goes red.
 *   2. Check the translation itself, by running the processor over that same
 *      real span and asserting the D8 result.
 *
 * The processor is invoked directly rather than registered on the provider so
 * step 1 sees the span before step 2 rewrites it — a MultiSpanProcessor calls
 * onEnd in exactly this way, so nothing is being simulated.
 */

const spans = captureSpans();

const MODEL_ID = "gpt-4o-mini";
const RESPONSE_MODEL_ID = "gpt-4o-mini-2024-07-18";
const ANSWER = "Restart the ingest pod, then re-check the collector queue.";
const SYSTEM_PROMPT = "You are the obstack test agent.";
const QUESTION = "What should I try first?";

/**
 * A LanguageModelV2 written out by hand rather than taken from `ai/test`:
 * `ai/test`'s mocks pull in `msw`, and a whole HTTP-mocking framework as a
 * transitive dev dependency is a steep price for six fields (S2.1 L1).
 */
const model = {
  specificationVersion: "v2",
  provider: "openai.chat",
  modelId: MODEL_ID,
  supportedUrls: {},
  async doGenerate() {
    return {
      content: [{ type: "text", text: ANSWER }],
      finishReason: "stop",
      usage: { inputTokens: 31, outputTokens: 12, totalTokens: 43 },
      warnings: [],
      response: { modelId: RESPONSE_MODEL_ID },
    };
  },
};

let raw: ReadableSpan;
let aiVersion: string;

before(async () => {
  const { generateText } = require("ai") as typeof import("ai");
  aiVersion = JSON.parse(
    readFileSync(path.join(path.dirname(require.resolve("ai")), "..", "package.json"), "utf8"),
  ).version;

  const result = await generateText({
    // The mock is a structural LanguageModelV2; `ai`'s own type is nominal
    // enough that a cast is cheaper than importing its provider package.
    model: model as never,
    system: SYSTEM_PROMPT,
    prompt: QUESTION,
    experimental_telemetry: { isEnabled: true },
  });
  assert.equal(result.text, ANSWER, "generateText did not run — nothing below would mean anything");

  const found = spans.finishedSpans().filter((span) => span.name === "ai.generateText.doGenerate");
  assert.equal(
    found.length,
    1,
    `ai ${aiVersion} emitted no ai.generateText.doGenerate span (saw: ${spans.finishedSpans().map((s) => s.name).join(", ") || "none"}). This SDK translates that span into the llm layer; without it there is no llm layer. ai 7 dropped OTel span emission entirely in favour of a diagnostics-channel integration registry, which is why the supported peer range stops below it.`,
  );
  raw = found[0]!;
});

after(async () => {
  await spans.shutdown();
});

test("ai still names the innermost provider call the way the processor looks it up", () => {
  assert.equal(raw.attributes["ai.operationId"], "ai.generateText.doGenerate");
});

test("ai still supplies the three fields the translation reads", () => {
  assert.equal(raw.attributes["ai.model.provider"], "openai.chat");
  assert.equal(
    raw.attributes["ai.prompt.messages"],
    JSON.stringify([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: QUESTION }] },
    ]),
  );
  assert.equal(raw.attributes["ai.response.text"], ANSWER);
});

test("ai still supplies the five D8 fields the translation deliberately does not set", () => {
  // These arrive already spelled the way ingest reads them, so the translation
  // leaves them alone. That is only safe while it stays true, which is what
  // this test is: if `ai` stops emitting them, the fix is to derive them from
  // the ai.* equivalents in vercel-ai.ts — not to delete this assertion.
  assert.equal(raw.attributes[D8.requestModel], MODEL_ID);
  assert.equal(raw.attributes[D8.responseModel], RESPONSE_MODEL_ID);
  assert.equal(raw.attributes[D8.inputTokens], 31);
  assert.equal(raw.attributes[D8.outputTokens], 12);
  assert.deepEqual(raw.attributes[D8.finishReasons], ["stop"]);
});

test("the outer ai.generateText span is left classified as something other than llm", () => {
  // Ingest classifies any span carrying a gen_ai.* attribute as llm. The outer
  // span carries none, and the translation must not give it any — two llm spans
  // for one model call would double the layer and confuse the cost column.
  const outer = spans.finishedSpans().find((span) => span.name === "ai.generateText");
  assert.ok(outer, "ai emitted no outer ai.generateText span");
  new VercelAiTranslationProcessor().onEnd(outer);
  const genAi = Object.keys(outer.attributes).filter((key) => key.startsWith("gen_ai."));
  assert.deepEqual(genAi, [], `the outer span picked up ${genAi.join(", ")}`);
});

test("the translated provider-call span carries the whole D8 GenAI attribute set", () => {
  new VercelAiTranslationProcessor().onEnd(raw);

  const missing = D8_LLM_ATTRIBUTES.filter((name) => raw.attributes[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `the translated span is missing ${missing.join(", ")}; ingest reads these names literally, so the span would land with no model, no tokens and no cost`,
  );

  // `ai` reports the qualified provider; D82 wants the bare vendor, because
  // that is what ingest's price list and the UI's provider column key on.
  assert.equal(raw.attributes[D8.system], "openai");
  assert.equal(raw.attributes[D8.prompt], raw.attributes["ai.prompt.messages"]);
  assert.equal(raw.attributes[D8.completion], ANSWER);
});

test("the translated span is renamed and re-kinded to match a first-party llm span", () => {
  new VercelAiTranslationProcessor().onEnd(raw);
  assert.equal(raw.name, `chat ${RESPONSE_MODEL_ID}`);
  assert.equal(raw.kind, SpanKind.CLIENT);
});

test("a span that is not a Vercel-AI provider call is left untouched", () => {
  const before = { ...raw.attributes };
  const foreign = {
    name: "GET /healthz",
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET" } as Record<string, unknown>,
  };
  new VercelAiTranslationProcessor().onEnd(foreign as unknown as ReadableSpan);
  assert.deepEqual(foreign.attributes, { "http.request.method": "GET" });
  assert.equal(foreign.name, "GET /healthz");
  assert.equal(foreign.kind, SpanKind.SERVER);
  assert.deepEqual({ ...raw.attributes }, before, "translating a foreign span disturbed an unrelated one");
});
