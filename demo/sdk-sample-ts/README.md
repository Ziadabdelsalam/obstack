# obstack-js sample (TypeScript)

A small Node service whose entire telemetry setup is the two lines the
`obstack-js` README documents:

```ts
import { init } from "obstack-js";
init();
```

One `POST /chat` runs an agent turn and lands the four-layer trace obstack
renders. There is no `@opentelemetry/*` import anywhere in `src/` — the api and
llm layers come out of the instrumentation `init()` registers, and the only
other telemetry calls in the app are the `traceAgent` / `traceTool` pair around
the two things no library can infer.

Where `demo/agent-app` is the bring-your-own-OpenTelemetry proof, this is the
SDK proof: same trace, ~40 lines less wiring.

## Run it

An obstack ingest has to be reachable at `:4318` — from `deploy/compose`,
`docker compose up -d clickhouse ingest`.

```bash
# from the repository root: build the SDK tarball a customer would install
npm pack ./packages/obstack-js --pack-destination ./demo/sdk-sample-ts

cd demo/sdk-sample-ts
npm install ./obstack-js-0.1.0.tgz   # already recorded in package.json; plain `npm install` does the same
npm install
npm run build

export OTEL_SERVICE_NAME=sdk-sample-ts
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local
npm start
```

Then, from another shell:

```bash
curl -s -X POST http://127.0.0.1:8100/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Why did checkout p99 latency jump this afternoon?"}'
```

```json
{"answer":"…","draft":"…","model":"gpt-4o-mini","facts":["…"]}
```

The response carries no trace id: reading one would mean importing the
OpenTelemetry API, and this sample's whole claim is that it imports none. Find
the trace by service name instead —

```bash
docker exec obstack-clickhouse clickhouse-client --query "
SELECT trace_id, count(), groupArray(layer), groupArray(name)
FROM obstack.spans WHERE service='sdk-sample-ts'
GROUP BY trace_id HAVING count() >= 4
ORDER BY max(start_time) DESC LIMIT 1 FORMAT Vertical"
```

The `HAVING` clause is not decoration — see "The model provider is this app"
below for the small extra traces it steps over. Spans are exported in batches, so
give it about five seconds — or stop the app (`Ctrl-C`), which flushes on the way
out.

## Installing the SDK

**Pre-release.** npm's `obstack-js` is a `0.0.1` name-hold placeholder marked
do-not-use, not this SDK, so this sample installs from source — which is what the
commands above do.

It comes in as the tarball `npm pack` produces, not as a
workspace link: the tarball is the artifact a customer gets, so this run
exercises its `files`, `exports` and type declarations rather than reaching
around them into `src/`. `package.json` records it as
`"obstack-js": "file:obstack-js-0.1.0.tgz"`; the tarball itself is a build
product and is gitignored, along with the lockfile it would pin by integrity
hash. Everything else is exact-pinned — this is an app, and an app that resolves
a different `ai` tomorrow stops being evidence.

## What one `/chat` emits

```
POST /chat                     api    node:http server span (http.request.method)
└─ agent.answer_question       agent  obstack.agent.step="answer_question"
   ├─ tool.knowledge_lookup    tool   obstack.tool.name="knowledge_lookup"
   ├─ ai.generateText          other  the Vercel AI SDK's outer span, no gen_ai.* on it
   │  └─ chat gpt-4o-mini      llm    translated from ai.generateText.doGenerate
   ├─ chat gpt-4o-mini         llm    the openai client's chat completions, patched
   └─ chat gpt-4o-mini         llm    the same client's Responses API, patched
```

Three llm spans, because obstack-js covers three Node paths by three different
patches and each is worth proving end to end:

| Leg | Library | How the span happens |
| --- | --- | --- |
| draft | `ai` 6 `generateText`, `experimental_telemetry: { isEnabled: true }` | `ai` emits its own span; obstack-js's span processor rewrites it into the attributes ingest reads |
| condense | `openai` 7 `chat.completions.create` | `openai/resources/chat/completions/completions.js` is patched when it is required |
| actionable | `openai` 7 `responses.create` | `openai/resources/responses/responses.js` is patched the same way; its finish reason is the response `status`, because the Responses API has no `finish_reason` |

All three spans carry the full GenAI set — `gen_ai.system`, request and response
model, input and output tokens, finish reason — and their prompt and completion.
Ingest moves those two into the dedicated `prompt` / `completion` columns and
removes them from the attributes map, so read them from the columns.
`ai.generateText`, the outer span, deliberately gets no `gen_ai.*` attributes:
one model call must not count as two llm spans.

`init()` must run before anything it patches is loaded, which is why `main.ts`
imports `obstack-js` and nothing else, and `require`s the server only after
`init()` has returned. A `import { createServer } from "node:http"` next to it
would be hoisted above `init()` by the compiler and the api layer would quietly
vanish.

## The model provider is this app

All three legs point their `baseURL` at `http://127.0.0.1:<PORT>/v1`, which this
same process serves: `POST /v1/chat/completions` returns a deterministic OpenAI
chat completion and `POST /v1/responses` a deterministic Response object
(`src/fake-openai.ts`). No API key, no network, same trace every run —
and the real clients still do all of their real work, which is the only way the
instrumentation is being tested at all. The fake reports `gpt-4o-mini`, a model
obstack prices, so `cost_usd` lands non-zero exactly as it would for a live
provider.

Those three self-calls arrive back at this server as ordinary HTTP requests, so
each one also produces its own single-span `api` trace. They are separate traces
rather than part of the agent's, because the clients use `fetch`, which the
SDK's HTTP instrumentation does not patch — no trace context goes out on those
requests. Nothing is lost from the agent trace; there is simply a small,
truthful trace beside it.

## Environment

The whole configuration surface, and it is entirely standard OpenTelemetry —
the app itself reads none of it:

| Variable | Purpose |
|----------|---------|
| `OTEL_SERVICE_NAME` | service name on every span |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ingest's OTLP/HTTP base URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer%20<key>` — **URL-encoded**, the exporter drops a header with a raw space |

Do not copy `demo/agent-app`'s block across: `obstack-js` builds its exporters
and batch processors itself, so `OTEL_TRACES_EXPORTER`, `OTEL_LOGS_EXPORTER`,
`OTEL_EXPORTER_OTLP_PROTOCOL` (the wire form is always OTLP protobuf over HTTP)
and the `OTEL_BSP_*` / `OTEL_BLRP_*` batch tuning are not read, and
`OTEL_SEMCONV_STABILITY_OPT_IN` is not consulted by the pinned HTTP
instrumentation either. Setting any of them here would suggest an effect they do
not have — see `packages/obstack-js/README.md`, "Configuration". The Python
sample's environment differs for real reasons; the two are not typos of each
other.

App-specific, optional:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8100` | the port the app listens on, and therefore where its own fake model endpoint lives |

## Container

`Dockerfile` builds from the **repository root** as context — it packs
`packages/obstack-js` itself and installs that tarball, so the image is built
the same way the instructions above are run:

```bash
docker build -f demo/sdk-sample-ts/Dockerfile -t sdk-sample-ts .
```

The compose service that uses it lives in `deploy/compose/docker-compose.yml`.
