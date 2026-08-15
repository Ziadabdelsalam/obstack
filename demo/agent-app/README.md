# obstack demo agent

A small FastAPI service that produces the telemetry obstack is built to read: one
agent turn per request, with an API span, an agent-step span, a tool span, an LLM
span, and correlated logs.

It uses **plain OpenTelemetry** — the stock Python SDK and the stock FastAPI
instrumentation, no obstack SDK and no vendor library. That is the point: it is
the running proof that any OTel-instrumented service can point at obstack and get
a full agent trace.

## Run it

From `deploy/compose`:

```bash
docker compose --profile demo up -d --build
curl -s -X POST http://127.0.0.1:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Why did checkout p99 latency jump this afternoon?"}'
```

The response carries the `trace_id` of the trace just emitted, so you can look it
up directly:

```json
{"trace_id":"…","answer":"…","model":"gpt-4o-mini","input_tokens":65,"output_tokens":44}
```

Standalone (an ingest reachable at `:4318` is still required):

```bash
pip install -r requirements.txt
export OTEL_SERVICE_NAME=demo-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local
export OTEL_SEMCONV_STABILITY_OPT_IN=http
uvicorn main:app --port 8000
```

## What one `/chat` emits

```
POST /chat                              api    auto-instrumented FastAPI server span
└─ agent.answer_question                agent  obstack.agent.step="answer_question"
   ├─ tool.knowledge_lookup             tool   obstack.tool.name="knowledge_lookup"
   │  └─ POST /internal/tools/knowledge api    the self-call's own server span
   └─ chat <model>                      llm    gen_ai.* attributes
```

The tool leg is a **real HTTP request back into this same app**, with the
traceparent injected by hand (`opentelemetry.propagate.inject`) and extracted by
the FastAPI instrumentation on the way in — so the trace only holds together if
context propagation actually works over the wire.

Logs go through the OTel `LoggingHandler` installed on the root logger, so
ordinary `logging.info(...)` calls made inside a span are exported carrying that
span's trace context. Three lines are emitted per turn (request received, lookup
result, answer produced), which is what the trace view's logs rail renders.

The `layer` column each span lands in is derived by ingest from these attributes,
per the D8 classification contract — the app never states a layer itself.

## GenAI attributes (D8)

The LLM span carries:

| Attribute | Value |
|-----------|-------|
| `gen_ai.system` | `openai` |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.request.model` / `gen_ai.response.model` | `gpt-4o-mini` by default |
| `gen_ai.prompt` / `gen_ai.completion` | the full prompt and answer text |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | token counts |
| `gen_ai.response.finish_reasons` | `["stop"]` |

`finish_reasons` is the semantic-convention **array** — that is what real GenAI
instrumentations emit, and the demo does not invent a flatter key for obstack's
own convenience. Ingest takes its first element for the singular `finish_reason`
column.

The model call is a **deterministic built-in fake** by default: same prompt, same
answer, same token counts, no network, no credentials. It reports itself as
`gpt-4o-mini` so the model is priced by the ingest pricing table and `cost_usd`
comes out non-zero. Set `OPENAI_API_KEY` and the same span wraps a real
`api.openai.com` chat completion instead.

## Environment

Exporter configuration is entirely standard OTel environment — the app reads
none of it directly:

| Variable | Purpose |
|----------|---------|
| `OTEL_SERVICE_NAME` | service name on every span and log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ingest's OTLP/HTTP base URL |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer%20<key>` — **URL-encoded**, the SDK drops a header with a raw space |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | `http`, so server spans carry `http.request.method` rather than the legacy `http.method` |
| `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_BLRP_SCHEDULE_DELAY` | export interval, ms |

App-specific, all optional:

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENAI_API_KEY` | unset | set to call the real API instead of the fake |
| `OPENAI_MODEL` | `gpt-4o-mini` | model name on both paths |
| `LOOP_INTERVAL_S` | unset | seconds between self-generated requests; unset disables |
| `DEMO_SELF_URL` | `http://127.0.0.1:8000` | base URL the tool self-call and the traffic loop dial |
