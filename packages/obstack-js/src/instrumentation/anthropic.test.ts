import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { D8, D8_LLM_ATTRIBUTES } from "../testing/d8-contract";
import { captureSpans, fakeProvider } from "../testing/harness";
import { AnthropicInstrumentation } from "./anthropic";

// Anthropic's coverage this sprint is unit-level (D77(e)): the real client
// against a local fake with an in-memory exporter. The OpenAI and Vercel-AI
// legs get the end-to-end ClickHouse proof; this one does not, and the README
// says exactly that rather than implying parity.
const spans = captureSpans();
const instrumentation = new AnthropicInstrumentation();
instrumentation.enable();

const RESPONSE = {
  id: "msg_obstack_test",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-5-20250929",
  content: [
    { type: "text", text: "Check the collector first." },
    { type: "text", text: " Then the ingest queue." },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 24, output_tokens: 11 },
};

const MESSAGES = [{ role: "user" as const, content: "Where do I start?" }];

let provider: Awaited<ReturnType<typeof fakeProvider>>;
let client: import("@anthropic-ai/sdk").Anthropic;

before(async () => {
  provider = await fakeProvider(RESPONSE);
  const { Anthropic } = require("@anthropic-ai/sdk") as typeof import("@anthropic-ai/sdk");
  client = new Anthropic({ apiKey: "not-a-real-key", baseURL: provider.baseURL, maxRetries: 0 });
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

test("a messages call through the real client produces one llm span", async () => {
  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 256,
    system: "You are the obstack test agent.",
    messages: MESSAGES,
  });

  assert.equal(message.content.length, 2, "the client's own result was altered");
  assert.equal(provider.requests.length, 1, "the request never reached the provider — the client was bypassed");

  const span = llmSpan();
  assert.equal(span.name, "chat claude-sonnet-4-5");
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

  assert.equal(span.attributes[D8.system], "anthropic");
  assert.equal(span.attributes[D8.requestModel], "claude-sonnet-4-5");
  assert.equal(span.attributes[D8.responseModel], "claude-sonnet-4-5-20250929");
  assert.equal(span.attributes[D8.inputTokens], 24);
  assert.equal(span.attributes[D8.outputTokens], 11);
});

test("the completion is the text blocks joined, and nothing else", () => {
  // A Message's content is a list of blocks. Only the text ones are what a
  // person reads; a tool-use block JSON-dumped into the completion column would
  // be noise in the one place the product shows the model's answer.
  assert.equal(llmSpan().attributes[D8.completion], "Check the collector first. Then the ingest queue.");
});

test("the prompt is the messages array as JSON, without the sibling system field", () => {
  // D82 says the request's messages array, verbatim. Anthropic carries the
  // system prompt outside that array; folding it in would be this SDK inventing
  // a message the caller never sent.
  assert.equal(llmSpan().attributes[D8.prompt], JSON.stringify(MESSAGES));
});

test("stop_reason is passed through verbatim as a single-element array", () => {
  assert.deepEqual(llmSpan().attributes[D8.finishReasons], ["end_turn"]);
});

test("prompt and completion are never emitted as span events", () => {
  assert.deepEqual(llmSpan().events, []);
});

test("a streaming request passes through with no span at all", async () => {
  const spansBefore = spans.finishedSpans().length;
  const requestsBefore = provider.requests.length;
  const stream = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 256,
    messages: MESSAGES,
    stream: true,
  });
  try {
    for await (const _ of stream) void _;
  } catch {
    // The fake answers JSON rather than SSE; parsing it is not under test.
  }
  assert.equal(
    provider.requests.length,
    requestsBefore + 1,
    "the streaming request never left the client, so 'no span' proves nothing",
  );
  assert.equal(spans.finishedSpans().length, spansBefore, "a streaming call produced a span");
});
