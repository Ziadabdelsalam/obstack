import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
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

/** A complete turn, carrying the key the client's own `addOutputText` triggers
 *  on so `output_text` is really a decorated string — BOTH spellings of it,
 *  because the trigger moved: 4.87.0 tests `rsp.type === "response"` and every
 *  5.x/6.x/7.x tests `rsp.object === "response"` (measured in both
 *  `resources/responses/responses.js`). One fixture decorates on both majors;
 *  the mapper reads neither key, so this changes nothing it is asked. */
const COMPLETED = {
  id: "resp_obstack_test",
  object: "response",
  type: "response",
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
  // The result: PROVEN RED TWICE, and the second time is why `openai.ts` reads
  // the body through `responsePromise` and a `Response.clone()` rather than by
  // watching the promise it hands back. See the version matrix at the bottom of
  // this file for both reds and the mechanism. This line is the pin: telemetry
  // that breaks the call it watches is worse than no telemetry.
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

test("responses.stream() passes through with no span and still reaches the provider", async () => {
  // The other streaming entry point, and the one the coverage table names
  // separately. `stream()` does not take `stream: true` from the caller —
  // `ResponseStream.createResponse` sets it on the way into this same patched
  // `create`, which is exactly why one guard covers both. Asserted here rather
  // than reasoned about, because "covered by the same guard" is a claim about
  // upstream's code that upstream is free to change.
  const spansBefore = spans.finishedSpans().length;
  const requestsBefore = completed.requests.length;

  const stream = client.responses.stream({ model: "gpt-4o-mini", input: INPUT });
  // The fake answers one JSON body rather than an SSE stream, so the helper
  // fails as soon as it tries to parse events. That is not what is under test;
  // what is under test is that the request went out and drew nothing.
  stream.on("error", () => {});
  try {
    await stream.done();
  } catch {
    // Expected: a JSON body is not an event stream.
  }

  assert.equal(
    completed.requests.length,
    requestsBefore + 1,
    "responses.stream() never reached the provider, so 'no span' proves nothing",
  );
  assert.equal(spans.finishedSpans().length, spansBefore, "responses.stream() produced a span");
});

/**
 * ## The fail-open exit: a body the observer cannot read (D316)
 *
 * `observeResponsesBody` returns undefined when there is no `responsePromise`
 * to watch, and `traceLlmCall` then ends the span carrying its REQUEST half
 * only — it cannot withhold the span, because the span is started before the
 * call so the provider's HTTP span nests under it. That is what the README
 * promises for a future `openai` that keeps the raw response somewhere else:
 * request attributes only, no completion, no token counts, and the
 * application's own value untouched.
 *
 * Nothing above reaches that branch, and nothing above can: `responsePromise`
 * is present on every version in the patched range (measured on 4.87.0, 7.4.0
 * and 7.8.0). So the branch is reached the one honest way — by calling the
 * PATCHED `Responses.prototype.create` with a stand-in `this` whose transport
 * hands back a value without one, which is exactly the shape the future client
 * this exit exists for would return. Everything else on the path is the real
 * thing: the real patch, the real `RESPONSES_SHAPE`, the real
 * `observeResponsesBody`, the real span lifecycle. No production code is
 * touched, and no test-only seam exists in `openai.ts` for this.
 */
const createWithTransport = (handedBack: unknown): unknown => {
  const prototype = Object.getPrototypeOf(client.responses) as {
    create: (this: unknown, ...args: unknown[]) => unknown;
  };
  // `create()` is `this._client.post(...)._thenUnwrap(...)` on every version in
  // the range, and it is the `_thenUnwrap` result — the value the APPLICATION
  // holds — that the observer is handed.
  const transport = { _client: { post: () => ({ _thenUnwrap: () => handedBack }) } };
  return prototype.create.call(transport, {
    model: "gpt-4o-mini",
    instructions: INSTRUCTIONS,
    input: INPUT,
  });
};

/** The half of D8 that only a read response body can fill in. */
const RESPONSE_HALF = [
  D8.responseModel,
  D8.completion,
  D8.inputTokens,
  D8.outputTokens,
  D8.finishReasons,
] as const;

/** The whole request half is there, and not one attribute of the response half:
 *  a span that guessed a completion or a zero token count would be worse than
 *  the missing half, because ingest prices what it is given. */
const assertRequestHalfOnly = (span: ReadableSpan): void => {
  assert.equal(span.name, "chat gpt-4o-mini");
  assert.equal(span.kind, SpanKind.CLIENT);
  assert.equal(span.attributes[D8.system], "openai");
  assert.equal(span.attributes[D8.requestModel], "gpt-4o-mini");
  assert.deepEqual(JSON.parse(String(span.attributes[D8.prompt])), [
    { role: "system", content: INSTRUCTIONS },
    { role: "user", content: INPUT },
  ]);
  for (const name of RESPONSE_HALF) {
    assert.equal(
      span.attributes[name],
      undefined,
      `${name} was set on a span whose response body was never read; the README promises request attributes only — no completion, no token counts`,
    );
  }
};

test("a promise with no responsePromise still ends one request-half span", () => {
  const seen = llmSpans().length;
  // The object the application is handed back, and the identity the assertion
  // below is about.
  const handedBack = { output_text: "the application's own value" };

  const returned = createWithTransport(handedBack);

  assert.equal(
    returned,
    handedBack,
    "the call did not get its own value back — fail-open means the application is unaffected, not chained off (D83)",
  );
  // Reached synchronously: the exit is taken before `create()` returns, and the
  // span is already in the exporter, which is what "ended, not left open" means.
  assertRequestHalfOnly(oneNewLlmSpan(seen));
});

test("a raw Response that cannot be cloned ends the same request-half span", async () => {
  // The second of the three fail-open exits, and the async one: there IS a
  // `responsePromise`, it resolves, and what it resolves to has no cloneable
  // `Response`. The span still ends with its request half and nothing invented.
  const seen = llmSpans().length;
  const handedBack = { responsePromise: Promise.resolve({ response: {} }) };

  const returned = createWithTransport(handedBack);
  assert.equal(returned, handedBack, "the application's value was replaced on the way out");

  await new Promise((resolve) => setImmediate(resolve));
  assertRequestHalfOnly(oneNewLlmSpan(seen));
});

/**
 * ## The version matrix: 4.87.0 and 7.8.0, in this one process
 *
 * Everything above runs against the `openai` in devDependencies, now `^7.8.0`.
 * That is not enough on its own, and the reason is the whole point of this
 * block.
 *
 * **A** — uninstrumented, `create()` followed by `parse()` succeeds. The
 * baseline: whatever instrumentation does, this must keep working.
 *
 * **B** — the historical failure, red twice, not shipped as a failing test
 * because a red test is not a suite. Both reds were measured here:
 *
 *   1. Observing the promise `create()` returns makes obstack the FIRST reader
 *      of the HTTP body, and the application's `parse()` then throws
 *      `TypeError: Body is unusable: Body has already been read` — on 4.87.0
 *      and on 7.8.0 alike.
 *   2. Memoising `parseResponse` on that promise (the first fix, `shareOneParse`)
 *      cured 4.87.0 and 7.4.0 and did nothing at all from 7.5.0: with it in
 *      place and `openai` at 7.8.0, this file failed with exactly the same
 *      throw, at `internal/parse.ts:65` → `client.ts:973` → `client.ts:989`
 *      (`client.js:508` in the shipped build) — the per-instance `_thenUnwrap`
 *      that closes over the module-local `parse` and never consults the memo.
 *      7.4.0 was the pinned devDependency, so CI was green while the CURRENT
 *      `openai` was broken inside the advertised peer range.
 *
 * **C** — with the shipped mechanism, on BOTH versions: the instrumentation
 * reads the body first (through `responsePromise` and a `Response.clone()`,
 * never the original), and the application's `parse()` still succeeds and still
 * yields `output_text`, and awaiting the promise `create()` returned still
 * succeeds, and each call draws exactly one span.
 *
 * One suite, two real clients, because B is a difference BETWEEN versions and a
 * suite that can only see one of them is how B shipped in the first place.
 */

/**
 * `openai` 4.87.0, loaded under its real name.
 *
 * It is installed as an npm alias (`openai487`: a package.json cannot name the
 * same dependency twice), and that is not enough by itself: require-in-the-middle
 * derives the module name from the PATH (`module-details-from-path` reads the
 * segment after `node_modules/`), so nothing under `node_modules/openai487/` is
 * ever matched by a module definition named `openai`. Measured — its
 * `Responses.prototype.create` comes back unpatched.
 *
 * Copying the package once into `node_modules/.obstack-openai487/node_modules/openai`
 * restores the one thing the matcher reads, the directory name, and nothing
 * else: it is the tree npm already resolved, copied inside this package so its
 * own dependencies (node-fetch, agentkeepalive, …) still resolve upward from the
 * installed tree. Nothing is downloaded, nothing is mutated, and the copy lands
 * in `node_modules`, which is not tracked. The version is asserted below so a
 * lockfile drift is loud rather than silently re-testing 7.8.0 twice.
 *
 * The copy is PUBLISHED BY RENAME rather than written into place. A `cpSync`
 * straight into `home` is not atomic: a Ctrl-C or a full disk mid-copy leaves a
 * half-copied tree that the reuse gate then accepts forever, and every later
 * run silently re-tests a truncated `openai` instead of 4.87.0. A rename within
 * one filesystem is atomic, so nothing partial is ever published under that
 * name; the gate still reads `package.json` rather than the directory, so a
 * partial tree left by an older run of this function is rebuilt rather than
 * trusted.
 */
function loadOpenAI487(): { OpenAI: typeof import("openai").OpenAI; version: string } {
  const alias = path.dirname(require.resolve("openai487"));
  const home = path.join(
    __dirname,
    "..",
    "..",
    "node_modules",
    ".obstack-openai487",
    "node_modules",
    "openai",
  );
  const marker = path.join(home, "package.json");
  if (!existsSync(marker)) {
    // Per-pid, because `node:test` runs each test FILE in its own process and
    // two of them may reach this line at once.
    const staging = `${home}.tmp-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(path.dirname(home), { recursive: true });
    cpSync(alias, staging, { recursive: true });
    // Only a half-copied tree from a run of the OLDER, non-atomic version of
    // this function can be here; a rename never leaves one.
    rmSync(home, { recursive: true, force: true });
    try {
      renameSync(staging, home);
    } catch (error) {
      // Renaming onto a non-empty directory fails: another process published
      // first. Its copy is as good as this one, so drop the staging tree and
      // use the winner — but only if there really is one.
      rmSync(staging, { recursive: true, force: true });
      if (!existsSync(marker)) throw error;
    }
  }
  const version = JSON.parse(readFileSync(marker, "utf8")).version as string;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return { OpenAI: (require(home) as typeof import("openai")).OpenAI, version };
}

interface Leg {
  readonly version: string;
  readonly client: Client;
  readonly fake: Fake;
}

let legacy: Fake;
let legacyClient: Client;
let legacyVersion = "";
let currentVersion = "";

before(async () => {
  legacy = await fakeProvider(COMPLETED);
  const old = loadOpenAI487();
  legacyVersion = old.version;
  assert.equal(legacyVersion, "4.87.0", "the openai487 alias no longer resolves 4.87.0");
  legacyClient = new old.OpenAI({
    apiKey: "not-a-real-key",
    baseURL: `${legacy.baseURL}/v1`,
    maxRetries: 0,
  });
  currentVersion = JSON.parse(
    readFileSync(path.join(path.dirname(require.resolve("openai")), "package.json"), "utf8"),
  ).version as string;
  // The major alone is not the claim. `7.x` is satisfied by 7.4.0, which is
  // precisely the version CI was pinned to while the CURRENT `openai` was
  // broken (B.2 above): the per-instance `_thenUnwrap` that defeated the first
  // fix arrives in 7.5.0, so 7.0–7.4 would pass a major-only guard and prove
  // nothing about the shape this file exists to cover.
  const [major, minor] = currentVersion.split(".").map((part) => Number.parseInt(part, 10));
  assert.ok(
    major === 7 && (minor ?? -1) >= 5,
    `the devDependency resolved openai ${currentVersion}; the 7.5+ per-instance \`_thenUnwrap\` shape is what this file exists for, and 7.0–7.4 would pass a major-only guard and prove nothing`,
  );
});

/** Built on use rather than in a hook, so the two `before()`s above cannot
 *  order themselves into a leg whose client is not up yet. */
const matrixLegs = (): Leg[] => [
  { version: currentVersion, client, fake: completed },
  { version: legacyVersion, client: legacyClient, fake: legacy },
];

after(async () => {
  await legacy?.close();
});

/**
 * Runs `body` with the patch lifted off every leg, then puts it back.
 *
 * `instrumentation.disable()` alone is not enough HERE, and only here: the
 * definition holds one `InstrumentationNodeModuleFile` per module path, whose
 * recorded exports are the last copy required — and this file deliberately has
 * two copies of `openai` loaded at once, which no application does. So
 * `disable()` unwraps one of them and leaves the other patched (measured: the
 * baseline below drew two spans). Restoring the function shimmer saved on
 * `__original` lifts it off both, which is what "uninstrumented" has to mean for
 * a baseline to be worth anything.
 */
async function uninstrumented<T>(clients: readonly Client[], body: () => Promise<T>): Promise<T> {
  const restore: Array<() => void> = [];
  for (const each of clients) {
    const prototype = Object.getPrototypeOf(each.responses) as Record<string, unknown>;
    const wrapped = prototype.create as { __original?: unknown } | undefined;
    if (typeof wrapped?.__original === "function") {
      restore.push(() => {
        prototype.create = wrapped;
      });
      prototype.create = wrapped.__original;
    }
  }
  assert.equal(restore.length, clients.length, "a leg was not patched to begin with");
  try {
    return await body();
  } finally {
    for (const put of restore) put();
  }
}

test("A — uninstrumented, create() then parse() succeeds on both versions", async () => {
  // The baseline the whole fix is judged against: this is the client an
  // application without obstack has, and it must keep working exactly as it is.
  const seen = llmSpans().length;
  const all = matrixLegs();
  await uninstrumented(
    all.map((leg) => leg.client),
    async () => {
      for (const leg of all) {
        const created = await leg.client.responses.create({ model: "gpt-4o-mini", input: INPUT });
        assert.equal(created.output_text, "Restart the ingest pod.", `create() failed on ${leg.version}`);
        const parsed = await leg.client.responses.parse({ model: "gpt-4o-mini", input: INPUT });
        assert.equal(parsed.output_text, "Restart the ingest pod.", `parse() failed on ${leg.version}`);
      }
    },
  );
  assert.equal(llmSpans().length, seen, "a span was drawn with the patch lifted off");
});

test("C — instrumented, parse() and create() both survive on both versions", async () => {
  for (const leg of matrixLegs()) {
    // The observer reads the body first, by construction: it registers on
    // `responsePromise` inside the patched `create`, before the promise is
    // handed back. If that read consumed the original body, this is where it
    // shows — this is exactly the call that threw before.
    const beforeParse = llmSpans().length;
    const parsed = await leg.client.responses.parse({ model: "gpt-4o-mini", input: INPUT });
    assert.equal(
      parsed.output_text,
      "Restart the ingest pod.",
      `instrumented parse() lost its body on openai ${leg.version}`,
    );
    const parseSpan = oneNewLlmSpan(beforeParse);
    assert.equal(parseSpan.attributes[D8.completion], "Restart the ingest pod.");
    assert.equal(parseSpan.attributes[D8.requestModel], "gpt-4o-mini");

    // And the plain call, awaited by the application itself.
    const beforeCreate = llmSpans().length;
    const created = await leg.client.responses.create({ model: "gpt-4o-mini", input: INPUT });
    assert.equal(
      created.output_text,
      "Restart the ingest pod.",
      `instrumented create() lost its body on openai ${leg.version}`,
    );
    const createSpan = oneNewLlmSpan(beforeCreate);
    assert.equal(createSpan.attributes[D8.completion], "Restart the ingest pod.");
    assert.equal(createSpan.attributes[D8.inputTokens], 29);
    assert.equal(createSpan.attributes[D8.outputTokens], 7);
  }
});
