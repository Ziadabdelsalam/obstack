import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { SpanKind, type Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { D8, D8_LLM_ATTRIBUTES } from "./testing/d8-contract";
import { captureSpans } from "./testing/harness";
import { VercelAiTranslationProcessor } from "./vercel-ai";

/**
 * The Vercel-AI leg is a translation, so this suite has three jobs and keeps
 * them apart:
 *
 *   1. Pin what `ai` actually emits. Every literal `vercel-ai.ts` reads is
 *      asserted against the INSTALLED version by running a real generateText —
 *      not against documentation, and not against what it emitted a major ago.
 *      When `ai` renames one of these, this is what goes red.
 *   2. Check the translation: the D8 attributes, the name, the kind.
 *   3. Check that the upstream content is GONE afterwards (D92) — by value, not
 *      by key list, because "the key is absent" is the hollow shape that let
 *      this leak ship in the first place.
 *
 * Job 1 reads snapshots taken before the processor runs, job 2 and 3 read the
 * live spans. Without the snapshots, an assertion like "gen_ai.prompt equals
 * ai.prompt.messages" would quietly become undefined === undefined the moment
 * the strip started working.
 */

const spans = captureSpans();

const MODEL_ID = "gpt-4o-mini";
const RESPONSE_MODEL_ID = "gpt-4o-mini-2024-07-18";
const ANSWER = "Restart the ingest pod, then re-check the collector queue.";
const SYSTEM_PROMPT = "You are the obstack test agent.";
const QUESTION = "What should I try first?";

/** Distinctive fragments of the fixture's input and output. The content probe
 *  hunts these across every attribute value of every span, so they have to be
 *  strings that could not plausibly turn up in metadata. */
const CONTENT_FRAGMENTS = [
  "obstack test agent", // the system prompt
  "What should I try first", // the user's question
  "re-check the collector queue", // the model's answer
];

/**
 * The measured `ai.*` enumeration, recorded here rather than inferred (D92).
 * Taken from `ai` 6.0.256 by dumping every `ai.*` attribute of both spans of one
 * `generateText` call and classifying each one by hand: does its VALUE carry
 * what the user wrote or what the model said?
 *
 * Content: 3. Metadata: 12. Anything `ai` emits that is in neither list fails
 * the enumeration test below — which is the point, because a new content-bearing
 * attribute upstream is a silent content leak here.
 */
const MEASURED_CONTENT = ["ai.prompt", "ai.prompt.messages", "ai.response.text"];
const MEASURED_METADATA = [
  "ai.model.id",
  "ai.model.provider",
  "ai.operationId",
  "ai.request.headers.user-agent",
  "ai.response.finishReason",
  "ai.response.id",
  "ai.response.model",
  "ai.response.timestamp",
  "ai.settings.maxRetries",
  "ai.usage.inputTokens",
  "ai.usage.outputTokens",
  "ai.usage.totalTokens",
];

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
let outer: ReadableSpan;
/** Attribute snapshots taken BEFORE the processor touched anything. */
let rawBefore: Attributes;
let outerBefore: Attributes;
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

  const outerFound = spans.finishedSpans().filter((span) => span.name === "ai.generateText");
  assert.equal(outerFound.length, 1, "ai emitted no outer ai.generateText span");
  outer = outerFound[0]!;

  rawBefore = { ...raw.attributes };
  outerBefore = { ...outer.attributes };

  // Exactly what the registered processor does to every span that ends.
  const processor = new VercelAiTranslationProcessor();
  for (const span of spans.finishedSpans()) processor.onEnd(span);
});

after(async () => {
  await spans.shutdown();
});

/* 1. what `ai` emits — asserted against the pre-translation snapshots */

test("ai still names the innermost provider call the way the processor looks it up", () => {
  assert.equal(rawBefore["ai.operationId"], "ai.generateText.doGenerate");
  assert.equal(outerBefore["ai.operationId"], "ai.generateText");
});

test("ai still supplies the three fields the translation reads", () => {
  assert.equal(rawBefore["ai.model.provider"], "openai.chat");
  assert.equal(
    rawBefore["ai.prompt.messages"],
    JSON.stringify([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [{ type: "text", text: QUESTION }] },
    ]),
  );
  assert.equal(rawBefore["ai.response.text"], ANSWER);
});

test("ai still supplies the five D8 fields the translation deliberately does not set", () => {
  // These arrive already spelled the way ingest reads them, so the translation
  // leaves them alone. That is only safe while it stays true, which is what
  // this test is: if `ai` stops emitting them, the fix is to derive them from
  // the ai.* equivalents in vercel-ai.ts — not to delete this assertion.
  assert.equal(rawBefore[D8.requestModel], MODEL_ID);
  assert.equal(rawBefore[D8.responseModel], RESPONSE_MODEL_ID);
  assert.equal(rawBefore[D8.inputTokens], 31);
  assert.equal(rawBefore[D8.outputTokens], 12);
  assert.deepEqual(rawBefore[D8.finishReasons], ["stop"]);
});

test("every ai.* attribute the pinned version emits is classified content or metadata", () => {
  // The standing guard behind D92's deletion list: a NEW content-bearing
  // attribute upstream is a silent leak, and the only way to notice one is to
  // refuse to recognise a key nobody has looked at. Classifying it is a
  // deliberate act — read the value, decide, add it to the right list, and add
  // it to AI_CONTENT_ATTRIBUTES in vercel-ai.ts if it carries content.
  const known = new Set([...MEASURED_CONTENT, ...MEASURED_METADATA]);
  const seen = [...new Set([...Object.keys(rawBefore), ...Object.keys(outerBefore)])]
    .filter((key) => key.startsWith("ai."))
    .sort();
  const unclassified = seen.filter((key) => !known.has(key));
  assert.deepEqual(
    unclassified,
    [],
    `ai ${aiVersion} emits ${unclassified.join(", ")}, which this enumeration has never classified. If any of them carries prompt or completion content it is going into the attributes Map unstripped.`,
  );
  assert.equal(seen.length, 15, `the enumeration was measured at 15 ai.* attributes, ai ${aiVersion} emits ${seen.length} (${seen.join(", ")})`);
  const contentSeen = seen.filter((key) => MEASURED_CONTENT.includes(key));
  assert.deepEqual(contentSeen, [...MEASURED_CONTENT].sort(), "the content attributes the enumeration was built on are no longer all emitted");
});

/* 2. the translation */

test("the translated provider-call span carries the whole D8 GenAI attribute set", () => {
  const missing = D8_LLM_ATTRIBUTES.filter((name) => raw.attributes[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `the translated span is missing ${missing.join(", ")}; ingest reads these names literally, so the span would land with no model, no tokens and no cost`,
  );

  // `ai` reports the qualified provider; D82 wants the bare vendor, because
  // that is what ingest's price list and the UI's provider column key on.
  assert.equal(raw.attributes[D8.system], "openai");
  // Compared against the snapshot, not against the live ai.* attribute, which
  // the strip has since removed — the old form of this assertion would now be
  // undefined === undefined and pass while proving nothing.
  assert.equal(raw.attributes[D8.prompt], rawBefore["ai.prompt.messages"]);
  assert.equal(raw.attributes[D8.completion], ANSWER);
});

test("the translated span is renamed and re-kinded to match a first-party llm span", () => {
  assert.equal(raw.name, `chat ${RESPONSE_MODEL_ID}`);
  assert.equal(raw.kind, SpanKind.CLIENT);
});

test("the outer ai.generateText span is left classified as something other than llm", () => {
  // Ingest classifies any span carrying a gen_ai.* attribute as llm. The outer
  // span carries none, and the translation must not give it any — two llm spans
  // for one model call would double the layer and confuse the cost column. It
  // is still stripped of content, which is a different question.
  const genAi = Object.keys(outer.attributes).filter((key) => key.startsWith("gen_ai."));
  assert.deepEqual(genAi, [], `the outer span picked up ${genAi.join(", ")}`);
  assert.equal(outer.name, "ai.generateText");
});

/* 3. the content strip (D92) */

test("the content probe is looking at something — the fragments really were emitted", () => {
  // Guards the probe below against passing on an empty span set or on fragments
  // that never appear. If this is red, the probe proves nothing.
  const all = JSON.stringify([rawBefore, outerBefore]);
  for (const fragment of CONTENT_FRAGMENTS) {
    assert.ok(all.includes(fragment), `"${fragment}" was never in the pre-translation attributes`);
  }
  assert.ok(spans.finishedSpans().length >= 2, "fewer than two spans to sweep");
});

test("no attribute value carries prompt or completion content, except the two keys ingest strips", () => {
  // By VALUE, not by key list (D92). A key-absence assertion is exactly what
  // missed this: `gen_ai.prompt` was absent from the Map and the same bytes sat
  // next to it under `ai.prompt.messages`. Ingest strips `gen_ai.prompt` and
  // `gen_ai.completion` and nothing else, so any other key holding this content
  // is content shipped into ClickHouse's attributes Map for good.
  const stripped = new Set<string>([D8.prompt, D8.completion]);
  const leaks: string[] = [];
  for (const span of spans.finishedSpans()) {
    for (const [key, value] of Object.entries(span.attributes)) {
      if (stripped.has(key)) continue;
      const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
      for (const fragment of CONTENT_FRAGMENTS) {
        if (text.includes(fragment)) leaks.push(`${span.name}: ${key} contains "${fragment}"`);
      }
    }
  }
  assert.deepEqual(
    leaks,
    [],
    `content survived translation in the attributes Map:\n  ${leaks.join("\n  ")}\nIngest only strips gen_ai.prompt and gen_ai.completion; everything else here lands in ClickHouse's Map beside the columns that exist to keep it out.`,
  );
});

test("the strip removes the measured content keys and keeps every metadata key", () => {
  for (const span of [raw, outer]) {
    const surviving = Object.keys(span.attributes).filter((key) => MEASURED_CONTENT.includes(key));
    assert.deepEqual(surviving, [], `${span.name} still carries ${surviving.join(", ")}`);
  }
  // The other half: a strip that took the metadata with it would pass the
  // content probe and quietly cost the trace its model, tokens and settings.
  const wasMetadata = (before: Attributes): string[] =>
    Object.keys(before).filter((key) => MEASURED_METADATA.includes(key));
  for (const [span, before] of [
    [raw, rawBefore],
    [outer, outerBefore],
  ] as const) {
    const lost = wasMetadata(before).filter((key) => span.attributes[key] === undefined);
    assert.deepEqual(lost, [], `${span.name} lost metadata ${lost.join(", ")} to the content strip`);
  }
});

test("a span that is not a Vercel-AI span is left untouched", () => {
  const foreign = {
    name: "GET /healthz",
    kind: SpanKind.SERVER,
    attributes: { "http.request.method": "GET", "ai.prompt": "not really ai's" } as Record<string, unknown>,
  };
  new VercelAiTranslationProcessor().onEnd(foreign as unknown as ReadableSpan);
  // No ai.operationId, so the processor does not recognise it and touches
  // nothing — including an attribute that merely looks like one of ours.
  assert.deepEqual(foreign.attributes, { "http.request.method": "GET", "ai.prompt": "not really ai's" });
  assert.equal(foreign.name, "GET /healthz");
  assert.equal(foreign.kind, SpanKind.SERVER);
});
