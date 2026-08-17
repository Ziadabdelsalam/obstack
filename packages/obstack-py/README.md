# obstack-py

Agent observability in two lines. `obstack.init()` configures OpenTelemetry from
the standard `OTEL_*` environment and turns on the instrumentation that produces
an obstack trace: an API span from your web framework, an LLM span from your
provider client with the prompt, completion, tokens and model on it, and agent
and tool spans from two decorators.

It is thin over the stock OpenTelemetry Python SDK — standard OTLP on the wire,
nothing proprietary — so it works against obstack's ingest, against a collector,
or against any other OTLP endpoint you point it at.

**Pre-release.** Not published to PyPI. Install from source as shown below. The
distribution is named `obstack-py` and imports as `obstack`.

## Install

```bash
pip install './packages/obstack-py[fastapi]'
```

The quotes are for zsh, which treats `[fastapi]` as a glob and otherwise fails
with `no matches found`; bash takes the line either way.

The `[fastapi]` extra adds the stock FastAPI instrumentation, which is what
produces the api layer for a FastAPI application. Leave it off and everything
else still works; you get three layers instead of four.

## Use

```python
import obstack

obstack.init()
```

Those are the two lines. Call them before your application object is created —
`init()` instruments FastAPI globally by patching its constructor, so an app
built beforehand is not covered.

Then mark the two things only your code knows about:

```python
import obstack
from openai import AsyncOpenAI

client = AsyncOpenAI()


@obstack.trace_tool
async def knowledge_lookup(question: str) -> list[str]:
    return await search(question)


@obstack.trace_agent
async def answer_question(question: str) -> str:
    facts = await knowledge_lookup(question)
    completion = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": f"{facts}\n\n{question}"}],
    )
    return completion.choices[0].message.content
```

One request through that produces:

```
POST /chat                  api    from the FastAPI instrumentation
└─ agent.answer_question    agent  obstack.agent.step="answer_question"
   ├─ tool.knowledge_lookup tool   obstack.tool.name="knowledge_lookup"
   └─ chat gpt-4o-mini      llm    gen_ai.* attributes
```

Both decorators take an optional name, `@obstack.trace_agent("plan")`, and
default to the function's own name. Both work on `def` and `async def`. Neither
records arguments or return values — the values flowing through an agent step
are exactly the customer data nobody agreed to send to an observability backend,
so capturing them is not something this SDK does quietly by default.

`init()` returns a handle with `shutdown()`, which flushes both pipelines. The
stock providers already flush at exit; call it explicitly in a short-lived
process or a worker being drained.

## What is instrumented

Exactly this, and nothing else:

| | Covered | Not covered |
|---|---|---|
| OpenAI | `chat.completions.create`, sync and async | streaming (`stream=True`), the Responses API |
| Anthropic | `messages.create`, sync and async | streaming (`stream=True`, `messages.stream()`) |
| api layer | FastAPI, via the `[fastapi]` extra | every other framework — bring the stock OTel instrumentation for it |
| logs | root-logger handler, correlated with the active span | — |

**Streaming calls pass through untraced.** A streamed completion is consumed
after the call returns, so a span closed around the call would carry no token
counts and would be priced at zero. An absent span is honest; a free one is not.

Evidence for the table: OpenAI is proven end to end into ClickHouse by
`demo/sdk-sample-py/`; Anthropic is proven at unit level in `tests/`, against the
real `anthropic` client talking to a local endpoint. Both suites drive the real
client library — nothing here is asserted against a stubbed response.

## GenAI attributes

The LLM span carries the D8 attribute set ingest reads:

| Attribute | Value |
|-----------|-------|
| `gen_ai.system` | `openai` or `anthropic` |
| `gen_ai.request.model` | the model you asked for |
| `gen_ai.response.model` | the model the provider answered with |
| `gen_ai.prompt` | the request's messages array, JSON, in order |
| `gen_ai.completion` | the assistant's text |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` | from the provider's usage block |
| `gen_ai.response.finish_reasons` | single-element array, the provider's own word |

Content capture is on and complete: the whole prompt, the whole completion, no
truncation and no opt-out. A trace whose LLM calls are redacted answers no
question anyone opens obstack to ask.

**Reading prompt and completion back:** they live only in obstack's dedicated
`prompt` and `completion` columns. Ingest deliberately leaves both keys out of a
span's attributes map, so a reader takes them from the columns and never from
`attributes['gen_ai.prompt']`.

No cost or price attribute is emitted, and no layer attribute: ingest computes
cost from the tokens and the model, and classifies the layer from the attributes
above. An SDK that stated either would be asserting something it does not own.

## Fail open

A broken telemetry stack never breaks the application. `init()` warns once and
returns a handle that does nothing rather than raising — including when an
`OTEL_*` value will not parse. The decorators call your function whether or not
a span could be started, your exceptions propagate untouched (recorded on the
span, status ERROR, when there is one), and your return value survives an
exporter that fails while the span is closing.

## Environment

Standard OpenTelemetry environment, all of it. There is no obstack-specific
variable, so an application that outgrows `init()` and writes its own OTel wiring
keeps every setting it already had.

| Variable | Purpose |
|----------|---------|
| `OTEL_SERVICE_NAME` | service name on every span and log |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP base URL, e.g. `http://127.0.0.1:4318` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer%20<key>` — **URL-encoded**, the SDK drops a header with a raw space |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | `init()` defaults it to `http`; without it FastAPI emits the legacy `http.method` and the api layer disappears |
| `OTEL_BSP_SCHEDULE_DELAY` / `OTEL_BLRP_SCHEDULE_DELAY` | export interval, ms |

A complete local run against a compose ingest:

```bash
export OTEL_SERVICE_NAME=my-agent
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local
uvicorn main:app --port 8000
```

## Development

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e './packages/obstack-py[fastapi]' -r ./packages/obstack-py/requirements-dev.txt
pytest packages/obstack-py
```

`pyproject.toml` states dependency ranges, because a library that pins exactly
makes itself uninstallable next to anything else. `requirements-dev.txt` states
the one combination the test evidence was produced on.
