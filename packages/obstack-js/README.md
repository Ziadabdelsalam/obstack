# obstack-js

The obstack SDK for Node.js. Two lines of setup, and an agent service produces
the four-layer trace obstack renders: an **api** span, an **agent** step, a
**tool** call and an **llm** span carrying the model, the token counts, the
prompt and the completion.

It is thin on purpose. Underneath it is the stock OpenTelemetry Node SDK talking
standard OTLP over HTTP, configured entirely from the standard `OTEL_*`
environment — so it points at obstack, at a stock OpenTelemetry Collector, or at
anything else that speaks OTLP, with no obstack-specific setting anywhere.

> **Pre-release.** npm holds `obstack-js 0.0.1` — a name-hold placeholder marked
> do-not-use (U5/D79), not this code. The real release publishes at launch;
> until then install from source, as shown below.

## Install

```bash
# pack from the obstack repo root; install from your app's directory
npm pack ./packages/obstack-js --pack-destination /path/to/your-app   # -> obstack-js-0.1.0.tgz
npm install ./obstack-js-0.1.0.tgz
```

Both paths need the leading `./`. Without it npm reads a bare `a/b` as a GitHub
shorthand and tries to clone `github.com/packages/obstack-js`, failing with an
unhelpful git error 128.

## The two lines

```ts
import { init } from "obstack-js";
init();
```

`init()` must run **before** the libraries it instruments are imported —
`openai`, `@anthropic-ai/sdk` and `node:http` are patched as they are required,
and a module loaded earlier keeps its unpatched copy. In practice that means
these two lines are the first thing your entry point does.

Then wrap the steps worth seeing:

```ts
import { init, traceAgent, traceTool } from "obstack-js";
init();

const OpenAI = require("openai").OpenAI;      // after init()
const openai = new OpenAI();

export async function answer(question: string) {
  return traceAgent("answer_question", async () => {
    const facts = traceTool("knowledge_lookup", () => lookup(question));
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `${question}\n\n${facts.join("\n")}` }],
    });
    return completion.choices[0]?.message.content;
  });
}
```

That produces:

```
GET /answer                  api    from instrumentation-http (http.request.method)
└─ agent.answer_question     agent  obstack.agent.step="answer_question"
   ├─ tool.knowledge_lookup  tool   obstack.tool.name="knowledge_lookup"
   └─ chat gpt-4o-mini       llm    gen_ai.* attributes
```

## Configuration

There are no obstack environment variables. Everything is standard OTel:

```bash
export OTEL_SERVICE_NAME=my-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local
```

`init()` sets nothing in your environment and reads nothing of its own. In
particular it does **not** touch `OTEL_SEMCONV_STABILITY_OPT_IN`: at the pinned
`@opentelemetry/instrumentation-http` range that variable is not consulted at
all, and the stable `http.request.method` — the attribute obstack classifies the
api layer on — is emitted whether it is set, unset or nonsense. There is no
env-ordering hazard to work around here. (The Python SDK is genuinely different
on this point; do not copy its setup across.)

Two standard groups are **not** read, because `init()` builds the exporters and
batch processors itself rather than letting the SDK assemble them from the
environment: the exporter-selection variables (`OTEL_TRACES_EXPORTER`,
`OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL` — the wire form is always
OTLP protobuf over HTTP), and the batch-tuning variables (`OTEL_BSP_*`,
`OTEL_BLRP_*`). Everything that decides where telemetry goes — endpoint,
headers, timeout, compression, certificates — is read from the environment as
usual.

## API

| | |
| --- | --- |
| `init(): ObstackSDK` | Configures tracing and logging and registers the instrumentations. Idempotent — a second call returns the first handle. Never throws. |
| `sdk.shutdown(): Promise<void>` | Flushes and stops the exporters. Never rejects. |
| `traceAgent<T>(step, fn): T \| Promise<T>` | Runs `fn` inside span `agent.<step>` with `obstack.agent.step=<step>`, kind INTERNAL. |
| `traceTool<T>(name, fn): T \| Promise<T>` | Runs `fn` inside span `tool.<name>` with `obstack.tool.name=<name>`, kind INTERNAL. |

`shutdown()` is not called for you. This library installs **no process signal
handlers** — a dependency that quietly takes over `SIGTERM` is a surprise in
someone else's application. Await it yourself before a deliberate exit.

`traceAgent` and `traceTool` capture **no arguments and no return values**. What
an agent step receives is arbitrary application data, and shipping it to a
telemetry backend is a decision this SDK does not make on your behalf.

## What is actually covered

Everything in this table was measured against the version named. Nothing else is
claimed.

| | Auto-instrumented | Not covered |
| --- | --- | --- |
| `openai` `>=4.85 <8` | `chat.completions.create` | streaming (`stream: true`), and `openai` below 4.85 — see below |
| `openai` `>=4.87 <8` | `responses.create`, and `responses.parse()` through it | streaming (`stream: true`, `responses.stream()`), `beta.responses`, `responses.compact()`, `responses.retrieve(id, { stream: true })`, and the Responses API below 4.87 — see below |
| `@anthropic-ai/sdk` `>=0.50 <1` | `messages.create` | streaming, `messages.stream()` |
| `ai` (Vercel AI SDK) `>=5 <7` | `generateText`, opted in per call with `experimental_telemetry: { isEnabled: true }` | `streamText` |
| `ai` (Vercel AI SDK) `>=7 <8` | `generateText`, on by default — no per-call option | `streamText`, and `ai` 7 on node below 22 — see below |
| `node:http` / `node:https` | server and client spans, always | — |

The optional peer ranges obstack-js actually declares are
`@anthropic-ai/sdk >=0.50 <1`, `ai >=5 <8` and `openai >=4.85 <8`. The table
splits some of them: `ai` gets a row per mechanism, because one range is covered
two different ways, and the Responses API gets its own floor inside `openai`'s
range. The package advertises the interval; the rows say what is true inside it.
(A test in this package reads those three ranges out of `package.json` and
requires them to appear here word for word, so this paragraph cannot drift away
from what npm installs.)

Streaming calls pass through **uninstrumented**, on every library and every
version in the table — `openai`'s `stream: true`, Anthropic's `messages.stream()`
and `ai`'s `streamText` alike, `ai` 7 included. The token counts arrive inside the
stream, and an LLM span reporting zero of them would be priced at $0 by ingest. A
missing span is an honest gap; a wrong cost is not.

Anthropic's coverage is proven at unit level — the real client against a local
fake with an in-memory exporter, which is also how the `ai` 7 leg is proven: the
suite drives the real `ai@7` with a stub model and asserts one complete llm span
per call. The end-to-end run this release ships covers the `openai` and `ai` 5/6
legs; Anthropic and `ai` 7 have no end-to-end evidence yet, and this table does
not imply parity.

**`openai` below 4.85.** The instrumentation patches
`openai/resources/chat/completions/completions.js`, and that module does not
exist before 4.85.0 — openai kept chat completions in a flat
`resources/chat/completions.js` through 4.84.1. Measured on 4.84.1: the call goes
out normally and produces no span and no error. That is why the supported range
starts at 4.85 rather than at 4.

**The OpenAI Responses API.** A second patch, on
`openai/resources/responses/responses.js`, with the same span shape as the chat
one: `chat <model>`, the same D8 attributes, no new names. `responses.parse()`
dispatches through `responses.create()`, so it is covered by the same patch and
counted once. `responses.stream()` does the same and is refused for the same
reason `stream: true` is — the tokens are in the stream. The neighbours that
build a response *without* going through `create()` are not covered at all:
`client.beta.responses` (a different class), `responses.compact()` and
`responses.retrieve(id, { stream: true })`.

Both are proven against the real client on **two** versions in one suite —
`openai` 4.87.0, the Responses floor, and 7.8.0, the current release — because
the way the instrumentation reads the response body has to be right on both.
`create()` hands back a promise DERIVED from the raw HTTP response and
`parse()` derives a second from it, and an HTTP body can be read once, so
obstack never reads the one your code reads: it takes a `Response.clone()`
before anything else touches it. If a future `openai` keeps that raw response
somewhere else, the span for that call carries its request attributes only —
no completion, no token counts — and obstack says so through `diag`. The span
cannot be withheld: it is started before the call so the HTTP span nests under
it. The call itself is untouched either way, which is the only promise that
matters here (D83).

One difference is worth knowing before you read a trace: the Responses API has
no finish_reason; obstack records the response `status` (`completed`,
`incomplete`, `failed`, …). The system prompt is folded into `gen_ai.prompt` as
a leading `{"role":"system"}` message when you send it as `instructions`, and a
bare-string `input` is captured as one `{"role":"user"}` message, so the same
conversation serialises the same way here as on the chat and `ai` legs.

**The Responses API below 4.87.** That module does not exist before 4.87.0:
measured on 4.85.4 and 4.86.2, `client.responses` is `undefined` and there is no
Responses call to make in the first place — the file matcher never fires, and
nothing here throws. The package range stays `>=4.85 <8` rather than moving up,
because chat coverage on 4.85 and 4.86 is real; the Responses row above carries
its own floor instead of the package advertising a narrower one than it has.

**Vercel AI SDK, 5 and 6.** No patching is involved: `ai` emits its own
OpenTelemetry spans, and `init()` registers a span processor that rewrites the
provider-call span (`ai.generateText.doGenerate`) into the attribute names
obstack reads. That processor also **deletes `ai`'s own content attributes** —
`ai.prompt`, `ai.prompt.messages`, `ai.response.text` and the
tool/structured-output keys beside them — from every `ai` span once it has read
what it needs. See "Reading prompts and completions back" below for why: the
content belongs in the dedicated columns, and a translation that left the
originals in place would be a copy. Metadata (`ai.usage.*`, model ids, settings,
`ai.operationId`) is untouched. On these versions telemetry is **opt-in, per
call**, and stays that way:

```ts
await generateText({ model, prompt, experimental_telemetry: { isEnabled: true } });
```

**Vercel AI SDK, 7.** A different mechanism, not a wider range on the same one.
`ai` 7 stopped emitting OpenTelemetry spans altogether — measured on 7.0.85, a
`generateText` call produces none, with `telemetry: { isEnabled: true }` and with
the deprecated `experimental_telemetry` alias alike — so there is nothing for the
processor above to translate. What it offers instead is a public integration
registry, and `init()` registers one obstack integration on it. Nothing is
patched, nothing is imported from `ai`, and there is no ordering constraint:
unlike the `openai` and `@anthropic-ai/sdk` legs, this one works even if `ai` was
loaded before `init()` ran.

The practical difference for your code is that **telemetry is on by default** on
7, so the call is just the call:

```ts
await generateText({ model, prompt });          // ai 7 — llm span, no option needed
```

To turn it off, use `ai`'s own switch, which silences every telemetry
integration you have registered rather than obstack alone:

```ts
await generateText({ model, prompt, telemetry: { isEnabled: false } });
```

One more thing about "on by default", because it is the one way to have obstack
installed, `init()` called, and still get no span for a call: `ai` 7's per-call
`telemetry.integrations` **replaces** the global registry for that call rather
than adding to it (`create-telemetry-dispatcher.ts:79-83`). So

```ts
await generateText({ model, prompt, telemetry: { integrations: [somethingElse] } });
```

draws nothing from obstack — not because obstack was disabled, but because that
call is dispatching to a different list. If you pass `integrations` per call and
still want obstack's span, include the object `init()` registered
(`globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`) in the array you pass.

`ai` 7 requires **node 22 or newer** (its own `engines` field). obstack-js stays
at node 20, because the 5/6 line runs there and raising the floor would drop apps
this SDK still covers — an app on node 20 simply cannot install `ai` 7 in the
first place.

**The `ai` 7 floor is 7.0.0.** That is measured, not
assumed: the published 7.0.x line is 80 releases, and 19 of them spread across it
(7.0.0, .1, .5, .11, .21, .23, .25, .31, .42, .51, .52, .54, .61, .66, .71, .73,
.79, .82, .85) were each driven with a real `generateText` against a stub model
and checked for the four things this leg depends on — the integration registry
being read at dispatch, the model call being wrapped with a call id, the
operation kind arriving under that same call id, and the result carrying the
token totals, the finish reason, the content parts and the response model. All
four hold on all nineteen, none diverged, and so the supported range is one
unbroken interval rather than one with a hole in it.

**Do not register `@ai-sdk/otel` as well.** It is Vercel's own OpenTelemetry
integration for `ai` 7 and it emits its own llm span for the same model call;
registered alongside obstack-js it gives you **two llm spans per call**, which
doubles the llm layer of every trace and the cost column with it. Pick one.
obstack-js has no way to detect the other and stand down — that would be a
promise keyed on a third party's class names across their future releases — so
this is a documented bound, not a guard.

**Module systems.** The build is CommonJS, and CJS is what the patching is
verified against. Pure-ESM `import` of `openai` / `@anthropic-ai/sdk` is not
claimed to be instrumented this release. The Vercel-AI path patches nothing and
therefore works under ESM either way.

**Logs.** `init()` registers an OTel `LoggerProvider` with an OTLP exporter, so
anything using the OTel logs API is exported and correlated. There is **no
bridge from `console`, `pino` or `winston`** in this release — ordinary log
calls are not captured.

## Reading prompts and completions back

The SDK sets `gen_ai.prompt` and `gen_ai.completion` as span attributes on the
wire. obstack's ingest moves both into dedicated columns and **removes them from
the attributes map**, so anything reading obstack's data takes them from the
`prompt` and `completion` columns and never from `attributes['gen_ai.prompt']`.

Ingest strips exactly those two names and never guesses at others — for a
service that brings its own OpenTelemetry, the map copy may be the only copy it
has, and obstack does not delete data it does not own. Keeping content out of the
map is therefore this SDK's job at the point of emission: obstack-js ships prompt
and completion content under those two keys and **no other**, which is why the
Vercel-AI translation deletes `ai`'s originals rather than leaving them beside
the values it derived from them.

Content capture is **on, in full, and has no off switch** in this release: the
prompt and the completion are the thing obstack exists to show you. Both are
stored verbatim, untruncated.

Cost is not computed here. obstack derives it at ingest from the token counts and
the model name, so the SDK carries no price list to go stale.

## Failing open

A broken telemetry endpoint never breaks the application (PRD §9):

- `init()` never throws. If setup fails it prints one warning and returns a
  handle that does nothing.
- `traceAgent` / `traceTool` call your function directly if a span cannot be
  started, and hand back its value even if the span cannot be ended.
- Your exceptions propagate exactly as thrown. They are recorded on the span and
  set its status to ERROR on the way past.
- `shutdown()` swallows a failed final flush rather than rejecting into an
  app that is already on its way out.

## Development

```bash
npm test --workspace packages/obstack-js          # tsx --test, node:test
npm run typecheck --workspace packages/obstack-js  # src plus the tests
npm run build --workspace packages/obstack-js      # dist/: CJS plus .d.ts
```

The unit suite drives the **real** provider clients against a deterministic local
HTTP fake — no API keys, and no hand-written stub standing in for the library
being patched. `src/attributes.ts` holds every attribute name the SDK emits, in
one place, because ingest reads those names literally and a typo there costs a
whole layer of the trace rather than failing a build.
