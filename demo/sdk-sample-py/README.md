# obstack SDK sample (Python)

A FastAPI service whose only telemetry code is `import obstack`, `obstack.init()`
and two decorators. One request produces the four-layer trace obstack is built to
read — api, agent, tool, llm, with the full GenAI attribute set on the LLM span —
and no module in this directory imports OpenTelemetry:

```bash
grep -rn opentelemetry demo/sdk-sample-py --include='*.py'   # no matches
```

That absence is the point. `demo/agent-app/` proves the bring-your-own-OTel path:
a service wiring the stock SDK itself gets a full obstack trace. This app proves
the other half — install the SDK, write two lines, get the same trace. It is its
own app rather than a conversion of the demo; what the two have in common is the
shape of what they emit.

## Run it

An ingest reachable at `:4318` is required; from `deploy/compose`:

```bash
docker compose up -d clickhouse ingest
```

Install, from the repository root:

```bash
python -m venv .venv && source .venv/bin/activate
pip install './packages/obstack-py[fastapi]'
pip install -r demo/sdk-sample-py/requirements.txt
```

The quotes are for zsh, which reads `[fastapi]` as a glob. The `[fastapi]` extra
is what produces the api layer — see the table below.

Run it, from the repository root as well:

```bash
export OTEL_SERVICE_NAME=sdk-sample-py
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local
export OTEL_BSP_SCHEDULE_DELAY=1000
export OTEL_BLRP_SCHEDULE_DELAY=1000
uvicorn main:app --app-dir demo/sdk-sample-py --port 8010
```

Then, in another shell:

```bash
curl -s -X POST http://127.0.0.1:8010/chat \
  -H 'Content-Type: application/json' \
  -d '{"message":"Why did checkout p99 latency jump this afternoon?"}'
```

```json
{"answer":"Based on the retrieved facts, the p99 on checkout tracks the vector-store lookup inside the agent step. Start there.","model":"gpt-4o-mini","input_tokens":66,"output_tokens":29}
```

Unlike `demo/agent-app`, the response carries no `trace_id`: reading the current
trace id takes an OpenTelemetry import, and this app has none. Find the trace by
service name, or pin its id from the caller — the FastAPI instrumentation
`init()` turned on extracts W3C trace context, so a `traceparent` header decides
the trace id, again with no code here:

```bash
trace_id=$(python3 -c 'import secrets; print(secrets.token_hex(16))')
curl -s -X POST http://127.0.0.1:8010/chat \
  -H 'Content-Type: application/json' \
  -H "traceparent: 00-$trace_id-$(python3 -c 'import secrets; print(secrets.token_hex(8))')-01" \
  -d '{"message":"Why did checkout p99 latency jump this afternoon?"}'
```

## What one `/chat` emits

```
POST /chat                  api    server span from the FastAPI instrumentation
├─ POST /chat http receive  other  ASGI plumbing
├─ agent.answer_question    agent  obstack.agent.step="answer_question"
│  ├─ tool.knowledge_lookup tool   obstack.tool.name="knowledge_lookup"
│  └─ chat gpt-4o-mini      llm    gen_ai.* attributes, kind CLIENT
└─ POST /chat http send     other  ASGI plumbing, twice
```

| Layer | Comes from | Application code |
|-------|------------|------------------|
| api | the FastAPI instrumentation `init()` enables (the `[fastapi]` extra) | none |
| agent | `@obstack.trace_agent` on `answer_question` | one decorator |
| tool | `@obstack.trace_tool` on `knowledge_lookup` | one decorator |
| llm | the `openai` client, patched by `init()` | the ordinary `chat.completions.create` call |

The three `other` spans describe the ASGI server's own plumbing. `demo/agent-app`
turns them off with an argument to `instrument_app`; `obstack.init()` takes no
arguments, so they are here. They cost three rows and change nothing about the
four layers.

Three log lines per request go out on the same trace context — `logging.info(...)`
through the root-logger handler `init()` installs, no logging code beyond the
`log.info` calls themselves.

## `init()` runs before FastAPI is imported

`init()` instruments FastAPI by replacing the class on the `fastapi` module. A
module that did `from fastapi import FastAPI` **first** holds the original class,
so every app it builds is uninstrumented — the api layer disappears from every
trace and nothing anywhere says so. Measured on this app: with the import first,
one request lands 3 spans (agent, tool, llm); with `init()` first, 7 spans and all
four layers.

So the two lines sit at the top of `main.py`, above the imports, and the imports
below them carry `# noqa: E402`. This is the same rule `obstack-js` states for
JavaScript — `init()` before the instrumented imports.

## The model provider

`fake_openai.py` serves a deterministic OpenAI-compatible endpoint on loopback
from this app's own process, and the real `openai` client is pointed at it with
`base_url`. There is no API key anywhere and nothing leaves the machine.

The client library is real because that is the thing being proven: obstack's
instrumentation patches `openai.resources.chat.completions`, so a client that was
stubbed out would demonstrate nothing about it. The endpoint reports the model as
`gpt-4o-mini`, which ingest's pricing table knows, so `cost_usd` comes out
non-zero the way it would against the real API.

It runs on its own thread rather than as a route on this FastAPI app, because a
model provider is not part of the application's trace: a route would be
instrumented like every other one and each request would emit a second,
meaningless trace holding only the provider's server span.

## Environment

Standard OpenTelemetry environment, all of it — the application reads none of it
and there is no obstack-specific variable:

| Variable | Purpose |
|----------|---------|
| `OTEL_SERVICE_NAME` | service name on every span and log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | ingest's OTLP/HTTP base URL |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer%20<key>` — **URL-encoded**, the SDK drops a header with a raw space |
| `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_BLRP_SCHEDULE_DELAY` | export interval, ms; 1000 so a single request is queryable a second later |

Every variable in that table is one something actually reads. `demo/agent-app`
also exports `OTEL_EXPORTER_OTLP_PROTOCOL`; it is absent here because nothing
reads it — `init()` constructs the OTLP/HTTP protobuf exporters itself, so the
wire form is fixed by the SDK. Measured: running with
`OTEL_EXPORTER_OTLP_PROTOCOL=grpc` set still lands the same seven spans over
HTTP. An application that needs a different wire form wires OpenTelemetry
itself, which is the path `demo/agent-app` shows.

`OTEL_SEMCONV_STABILITY_OPT_IN` is missing from that list on purpose, and
`demo/agent-app` sets it: without it the FastAPI instrumentation emits the legacy
`http.method` and the api layer silently dies. `obstack.init()` defaults it to
`http`, which is measurable here — the api span above carries
`http.request.method` although nothing in this runbook ever set the variable.
That default is one of the things the two lines buy.

## Docker

The image builds from the repository **root**, because it installs
`packages/obstack-py`:

```bash
docker build -f demo/sdk-sample-py/Dockerfile -t obstack-sdk-sample-py .
```

`Dockerfile.dockerignore` beside it keeps `node_modules` and `.git` out of that
context. The image runs the same two install commands this README gives a human,
and listens on 8010 like the runbook above.

## Checking it landed

With `trace_id` from the pinned-`traceparent` run above, from `deploy/compose`:

```bash
docker compose exec -T clickhouse clickhouse-client \
  --user obstack_web --password obstack_web_dev --query "
SELECT count() AS spans,
       arraySort(groupUniqArray(layer)) AS layers,
       countIf(layer='llm' AND prompt != '' AND completion != '') AS llm_with_content,
       sumIf(input_tokens, layer='llm') AS input_tokens,
       sumIf(output_tokens, layer='llm') AS output_tokens,
       maxIf(cost_usd, layer='llm') AS cost_usd
FROM obstack.spans WHERE trace_id = '$trace_id' FORMAT Vertical"
```

```
spans:            7
layers:           ['other','api','agent','tool','llm']
llm_with_content: 1
input_tokens:     66
output_tokens:    29
cost_usd:         0.0000273
```

`prompt` and `completion` are read from those columns and never from
`attributes['gen_ai.prompt']`: ingest keeps both keys out of the attributes map
by design, so a reader looking there finds nothing.
