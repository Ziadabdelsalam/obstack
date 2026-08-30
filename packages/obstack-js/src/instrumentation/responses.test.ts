import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { SpanKind } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { D8, D8_LLM_ATTRIBUTES } from "../testing/d8-contract";
import { captureSpans, fakeProvider } from "../testing/harness";
import { OpenAIInstrumentation } from "./openai";

// The OpenAI Responses API, proven the same way the chat leg is: the REAL
// client against a local fake over real HTTP, with an in-memory exporter. The
// patch is installed on require, so the tracer provider and the instrumentation
// both have to exist before `openai` is loaded — which is why the clients are
// required down in `before()` rather than imported up here.
//
// Three fakes rather than one: the harness answers ONE canned body for every
// route, and three of the cases below are about what different bodies do to the
// mapper (a completed turn, a tool-call-only turn, and a payload the client
// declines to decorate). That is a per-fake difference, not a harness one.
const spans = captureSpans();
const instrumentation = new OpenAIInstrumentation();
instrumentation.enable();

const INSTRUCTIONS = "You are the obstack test agent.";
const INPUT = "What should I try first?";

/** A complete turn, `object: "response"` included so the client's own
 *  `addOutputText` really runs and `output_text` is a decorated string. */
const COMPLETED = {
  id: "resp_obstack_test",
  object: "response",
  created_at: 1735689600,
  status: "completed",
  error: null,
  incomplete_details: null,
  model: "gpt-4o-mini-2024-07-18",
  output: [
    {
      id: "msg_obstack_test",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Restart the ingest pod.", annotations: [] }],
    },
  ],
  usage: { input_tokens: 29, output_tokens: 7, total_tokens: 36 },
};

/** A turn that produced a tool call and no prose, cut short by the token cap. */
const TOOL_ONLY = {
  id: "resp_obstack_tool",
  object: "response",
  created_at: 1735689601,
  status: "incomplete",
  error: null,
  incomplete_details: { reason: "max_output_tokens" },
  model: "gpt-4o-mini-2024-07-18",
  output: [
    { id: "rs_obstack", type: "reasoning", summary: [] },
    {
      id: "fc_obstack",
      type: "function_call",
      call_id: "call_obstack",
      name: "restart_pod",
      arguments: '{"pod":"ingest"}',
      status: "completed",
    },
  ],
  usage: { input_tokens: 41, output_tokens: 12, total_tokens: 53 },
};

/** The same completed turn with `object` OMITTED: the client only decorates a
 *  payload that identifies itself as a response, so `output_text` is absent
 *  here and the completion has to come from the `output[]` walk instead. */
const UNDECORATED = {
  id: "resp_obstack_bare",
  created_at: 1735689602,
  status: "completed",
  model: "gpt-4o-mini-2024-07-18",
  output: [
    {
      id: "msg_obstack_bare",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        { type: "output_text", text: "Check the collector.", annotations: [] },
        { type: "output_text", text: " Then the queue.", annotations: [] },
      ],
    },
  ],
  usage: { input_tokens: 18, output_tokens: 9, total_tokens: 27 },
};

type Fake = Awaited<ReturnType<typeof fakeProvider>>;
type Client = import("openai").OpenAI;

let completed: Fake;
let toolOnly: Fake;
let undecorated: Fake;
let client: Client;
let toolClient: Client;
let bareClient: Client;

before(async () => {
  [completed, toolOnly, undecorated] = await Promise.all([
    fakeProvider(COMPLETED),
    fakeProvider(TOOL_ONLY),
    fakeProvider(UNDECORATED),
  ]);
  const { OpenAI } = require("openai") as typeof import("openai");
  const open = (fake: Fake): Client =>
    new OpenAI({ apiKey: "not-a-real-key", baseURL: `${fake.baseURL}/v1`, maxRetries: 0 });
  client = open(completed);
  toolClient = open(toolOnly);
  bareClient = open(undecorated);
});

after(async () => {
  instrumentation.disable();
  await Promise.all([completed.close(), toolOnly.close(), undecorated.close()]);
  await spans.shutdown();
});

const llmSpans = (): ReadableSpan[] =>
  spans.finishedSpans().filter((span) => span.attributes[D8.system] !== undefined);

/**
 * The one span a call just drew. Counted rather than assumed: several calls in
 * this file draw spans, and "the last one" would pass just as happily if a call
 * drew two (`parse()` dispatches through `create()`, so a double count is a
 * real failure mode) or if the patch never ran and every attribute assertion
 * below went vacuous against an empty span.
 */
const oneNewLlmSpan = (before: number): ReadableSpan => {
  const found = llmSpans();
  assert.equal(
    found.length,
    before + 1,
    `expected exactly one new LLM span, saw ${found.length - before} (${spans.finishedSpans().map((s) => s.name).join(", ") || "none"})`,
  );
  return found[found.length - 1]!;
};

test("a responses call through the real client produces one llm span", async () => {
  const seen = llmSpans().length;
  const { data, response } = await client.responses
    .create({ model: "gpt-4o-mini", instructions: INSTRUCTIONS, input: INPUT })
    .withResponse();

  // The application's own result is untouched — including `withResponse()`,
  // which only works because instrumentation observes the APIPromise rather
  // than replacing it with a plain promise chained off it.
  assert.equal(data.output_text, "Restart the ingest pod.");
  assert.equal(
    response.url,
    `${completed.baseURL}/v1/responses`,
    "the call did not go to the Responses route, so nothing below is about the Responses API",
  );
  assert.equal(completed.requests.length, 1, "the request never reached the provider — the client was bypassed");
  assert.deepEqual(completed.requests[0], {
    model: "gpt-4o-mini",
    instructions: INSTRUCTIONS,
    input: INPUT,
  });

  const span = oneNewLlmSpan(seen);
  // Same span name as the chat leg (there is no `responses` operation name in
  // the semantic conventions to use instead, and ingest classifies the llm
  // layer by the gen_ai.* attributes rather than by the name).
  assert.equal(span.name, "chat gpt-4o-mini");
  assert.equal(span.kind, SpanKind.CLIENT);
});

test("the responses span carries the whole D8 GenAI attribute set", () => {
  const span = llmSpans()[0]!;
  const missing = D8_LLM_ATTRIBUTES.filter((name) => span.attributes[name] === undefined);
  assert.deepEqual(
    missing,
    [],
    `the llm span is missing ${missing.join(", ")}; ingest reads these names literally, so a rename does not fail a build — it lands a span with no model, no tokens and no cost`,
  );

  assert.equal(span.attributes[D8.system], "openai");
  assert.equal(span.attributes[D8.requestModel], "gpt-4o-mini");
  assert.equal(span.attributes[D8.responseModel], "gpt-4o-mini-2024-07-18");
  assert.equal(span.attributes[D8.inputTokens], 29);
  assert.equal(span.attributes[D8.outputTokens], 7);
  assert.equal(span.attributes[D8.completion], "Restart the ingest pod.");
  assert.deepEqual(span.attributes[D8.finishReasons], ["completed"]);
  // D38 FINAL: content lives on attributes, never on events.
  assert.deepEqual(span.events, []);
});

test("instructions arrive as the leading system message of the prompt array", () => {
  // D300, one wire form for every path: the Responses API keeps the system
  // prompt in `instructions`, a sibling of `input`, so serialising `input`
  // alone would land a span whose captured content silently lacks it. A bare
  // string `input` is the API's own equivalent of one user message.
  const prompt = JSON.parse(String(llmSpans()[0]!.attributes[D8.prompt])) as unknown[];
  assert.deepEqual(prompt, [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: INPUT },
  ]);
});

test("a tool-call-only turn records no completion and the incomplete status", async () => {
  const seen = llmSpans().length;
  const result = await toolClient.responses.create({ model: "gpt-4o-mini", input: INPUT });
  assert.equal(result.output[1]?.type, "function_call");

  const span = oneNewLlmSpan(seen);
  assert.equal(
    span.attributes[D8.completion],
    "",
    "a turn with no prose has no completion; inventing one would put reasoning or arguments in the column a human reads",
  );
  // D301: the Responses API has no finish_reason at all, so the provider-native
  // `status` is what is recorded — verbatim, not folded together with
  // `incomplete_details.reason`, which would be a composite this SDK invented.
  assert.deepEqual(span.attributes[D8.finishReasons], ["incomplete"]);
  assert.equal(span.attributes[D8.inputTokens], 41);
  assert.equal(span.attributes[D8.outputTokens], 12);
});

test("the completion survives a payload the client does not decorate", async () => {
  const seen = llmSpans().length;
  const result = await bareClient.responses.create({ model: "gpt-4o-mini", input: INPUT });
  // `output_text` is added by the CLIENT, and only to a payload that says
  // `object: "response"`. This one does not, so the field really is absent —
  // which is why the mapper recomputes from `output[]` instead of trusting it.
  assert.equal((result as { output_text?: unknown }).output_text, undefined);

  assert.equal(
    oneNewLlmSpan(seen).attributes[D8.completion],
    "Check the collector. Then the queue.",
    "the output[] walk lost the completion the client never decorated",
  );
});

test("a streaming responses request passes through with no span at all", async () => {
  // Same posture as the chat leg, and the same guard: `stream: true` reaches
  // the mapper from `create({stream:true})` and from `responses.stream()`
  // alike. The tokens arrive inside the stream, and a gen_ai span reporting
  // zero of them would be priced at $0 by ingest — a missing span is an honest
  // gap, a wrong cost is not.
  const spansBefore = spans.finishedSpans().length;
  const requestsBefore = completed.requests.length;
  const stream = await client.responses.create({ model: "gpt-4o-mini", input: INPUT, stream: true });
  // The fake answers with a plain JSON body rather than SSE, so the stream ends
  // immediately; what matters is that the call really went out and drew nothing.
  try {
    for await (const _ of stream) void _;
  } catch {
    // Parsing a non-SSE body is expected here and is not what is under test.
  }
  assert.equal(
    completed.requests.length,
    requestsBefore + 1,
    "the streaming request never left the client, so 'no span' proves nothing",
  );
  assert.equal(spans.finishedSpans().length, spansBefore, "a streaming call produced a span");
});

test("parse() still works, and draws exactly one span", async () => {
  // Two failure modes at once, and both were real.
  //
  // The count: `responses.parse()` dispatches through `responses.create()`, so
  // it is covered for free — and a second patch site would double-count it.
  //
  // The result: PROVEN RED FIRST. `create()` hands back a derived APIPromise
  // and `parse()` derives another from it, and `_thenUnwrap` bypasses the
  // parent's parse memo — so observing the call read the HTTP body first and
  // the application's own `parse()` then threw `TypeError: Body is unusable:
  // Body has already been read`. Uninstrumented it succeeds; instrumented it
  // did not. `shareOneParse` in `openai.ts` is the fix, and this line is the
  // pin: telemetry that breaks the call it watches is worse than no telemetry.
  const seen = llmSpans().length;
  const parsed = await client.responses.parse({ model: "gpt-4o-mini", input: INPUT });
  assert.equal(parsed.output_text, "Restart the ingest pod.");

  const span = oneNewLlmSpan(seen);
  assert.equal(span.name, "chat gpt-4o-mini");
  assert.equal(span.attributes[D8.completion], "Restart the ingest pod.");
});

test("an array input is serialised untouched, after the system element", async () => {
  const seen = llmSpans().length;
  const items = [
    { role: "user" as const, content: "Where do I start?" },
    { role: "assistant" as const, content: "Check the collector." },
  ];
  await client.responses.create({ model: "gpt-4o-mini", instructions: INSTRUCTIONS, input: items });

  const prompt = JSON.parse(String(oneNewLlmSpan(seen).attributes[D8.prompt])) as unknown[];
  assert.equal(prompt.length, 3, "the array input was rewritten rather than passed through");
  assert.deepEqual(prompt[0], { role: "system", content: INSTRUCTIONS });
  assert.deepEqual(prompt.slice(1), items);
});
