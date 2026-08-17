import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { D8, D8_LLM_ATTRIBUTES } from "../testing/d8-contract";
import { captureSpans, fakeProvider } from "../testing/harness";
import { OpenAIInstrumentation } from "./openai";

// The patch is installed on require, so the tracer provider and the
// instrumentation both have to exist before `openai` is loaded — which is why
// the client is required down in `before()` rather than imported up here. It is
// also exactly the ordering the README tells applications to use.
const spans = captureSpans();
const instrumentation = new OpenAIInstrumentation();
instrumentation.enable();

const RESPONSE = {
  id: "chatcmpl-obstack-test",
  model: "gpt-4o-mini-2024-07-18",
  choices: [
    { index: 0, message: { role: "assistant", content: "Restart the ingest pod." }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 31, completion_tokens: 6, total_tokens: 37 },
};

const MESSAGES = [
  { role: "system" as const, content: "You are the obstack test agent." },
  { role: "user" as const, content: "What should I try first?" },
];

let provider: Awaited<ReturnType<typeof fakeProvider>>;
let client: import("openai").OpenAI;

before(async () => {
  provider = await fakeProvider(RESPONSE);
  const { OpenAI } = require("openai") as typeof import("openai");
  client = new OpenAI({ apiKey: "not-a-real-key", baseURL: `${provider.baseURL}/v1`, maxRetries: 0 });
});

after(async () => {
  instrumentation.disable();
  await provider.close();
  await spans.shutdown();
});

const llmSpan = (): ReadableSpan => {
  const found = spans.finishedSpans().filter((span) => span.attributes[D8.system] !== undefined);
  assert.equal(
    found.length,
    1,
    `expected exactly one LLM span, saw ${found.length} (${spans.finishedSpans().map((s) => s.name).join(", ") || "none"}). Zero would mean the patch never ran — and every attribute assertion below would then pass vacuously against an empty span.`,
  );
  return found[0]!;
};

test("a chat completion through the real client produces one llm span", async () => {
  const completion = await client.chat.completions.create({ model: "gpt-4o-mini", messages: MESSAGES });

  // The application's own result is untouched: instrumentation observes the
  // APIPromise, it does not replace it.
  assert.equal(completion.choices[0]?.message.content, "Restart the ingest pod.");
  assert.equal(provider.requests.length, 1, "the request never reached the provider — the client was bypassed");

  const span = llmSpan();
  assert.equal(span.name, "chat gpt-4o-mini");
  assert.equal(span.kind, SpanKind.CLIENT);
});

test("the span carries the whole D8 GenAI attribute set", () => {
  const span = llmSpan();
  const missing = D8_LLM_ATTRIBUTES.filter((name) => span.attributes[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `the llm span is missing ${missing.join(", ")}; ingest reads these names literally, so a rename does not fail a build — it lands a span with no model, no tokens and no cost`,
  );

  assert.equal(span.attributes[D8.system], "openai");
  assert.equal(span.attributes[D8.requestModel], "gpt-4o-mini");
  assert.equal(span.attributes[D8.responseModel], "gpt-4o-mini-2024-07-18");
  assert.equal(span.attributes[D8.inputTokens], 31);
  assert.equal(span.attributes[D8.outputTokens], 6);
  assert.equal(span.attributes[D8.completion], "Restart the ingest pod.");
});

test("the prompt is the request's messages array as JSON, in order", () => {
  // D82: verbatim order, JSON string. Ingest moves it to a dedicated ZSTD
  // column and strips the key from the attributes Map, so this is the only
  // place the shape is asserted before it leaves the process.
  assert.equal(llmSpan().attributes[D8.prompt], JSON.stringify(MESSAGES));
});

test("the finish reason is a single-element array", () => {
  // D8-AMENDMENT accepts the scalar or `…finish_reasons[0]`; D82 picks the
  // array. Ingest reads index 0, so a bare string here reads back as empty.
  assert.deepEqual(llmSpan().attributes[D8.finishReasons], ["stop"]);
});

test("prompt and completion are never emitted as span events", () => {
  // D38 FINAL: ingest does not implement span-event extraction, so content on
  // events lands unreadable. The span-attribute form above is the only shape.
  assert.deepEqual(llmSpan().events, []);
});

test("a streaming request passes through with no span at all", async () => {
  // D77(e), stated honestly rather than half-instrumented: tokens arrive in the
  // stream, and a gen_ai span reporting zero of them would be priced at $0 by
  // ingest. A missing span is an honest gap; a $0 row is a wrong number.
  const spansBefore = spans.finishedSpans().length;
  const requestsBefore = provider.requests.length;
  const stream = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: MESSAGES,
    stream: true,
  });
  // The fake answers with a plain JSON body rather than SSE, so the stream ends
  // immediately; what matters is that the call really went out and drew nothing.
  try {
    for await (const _ of stream) void _;
  } catch {
    // Parsing a non-SSE body is expected here and is not what is under test.
  }
  assert.equal(
    provider.requests.length,
    requestsBefore + 1,
    "the streaming request never left the client, so 'no span' proves nothing",
  );
  assert.equal(spans.finishedSpans().length, spansBefore, "a streaming call produced a span");
});
