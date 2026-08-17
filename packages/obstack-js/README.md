# obstack-js

The obstack SDK for Node.js. Two lines of setup, and an agent service produces
the four-layer trace obstack renders: an **api** span, an **agent** step, a
**tool** call and an **llm** span carrying the model, the token counts, the
prompt and the completion.

It is thin on purpose. Underneath it is the stock OpenTelemetry Node SDK talking
standard OTLP over HTTP, configured entirely from the standard `OTEL_*`
environment — so it points at obstack, at a stock OpenTelemetry Collector, or at
anything else that speaks OTLP, with no obstack-specific setting anywhere.

> **Pre-release.** Not published to npm. Install it from source, as shown below.

## Install

```bash
npm pack packages/obstack-js          # -> obstack-js-0.1.0.tgz
npm install ./obstack-js-0.1.0.tgz
```

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
| `openai` `>=4.85 <8` | `chat.completions.create` | streaming (`stream: true`), the Responses API, and `openai` below 4.85 — see below |
| `@anthropic-ai/sdk` `>=0.50 <1` | `messages.create` | streaming, `messages.stream()` |
| `ai` (Vercel AI SDK) `>=5 <7` | `generateText` with `experimental_telemetry: { isEnabled: true }` | `streamText`, and `ai` 7 — see below |
| `node:http` / `node:https` | server and client spans, always | — |

Streaming calls pass through **uninstrumented**. The token counts arrive inside
the stream, and an LLM span reporting zero of them would be priced at $0 by
ingest. A missing span is an honest gap; a wrong cost is not.

Anthropic's coverage is proven at unit level — the real client against a local
fake with an in-memory exporter. The end-to-end run this release ships covers the
`openai` and Vercel-AI legs; Anthropic has no end-to-end evidence yet, and this
table does not imply parity.

**`openai` below 4.85.** The instrumentation patches
`openai/resources/chat/completions/completions.js`, and that module does not
exist before 4.85.0 — openai kept chat completions in a flat
`resources/chat/completions.js` through 4.84.1. Measured on 4.84.1: the call goes
out normally and produces no span and no error. That is why the supported range
starts at 4.85 rather than at 4.

**Vercel AI SDK.** No patching is involved: `ai` emits its own OpenTelemetry
spans, and `init()` registers a span processor that rewrites the provider-call
span (`ai.generateText.doGenerate`) into the attribute names obstack reads.
`ai` 7 removed OTel span emission in favour of a `node:diagnostics_channel`
integration registry, so there is nothing left for that processor to translate —
hence the `<7` bound. Enable telemetry per call:

```ts
await generateText({ model, prompt, experimental_telemetry: { isEnabled: true } });
```

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
