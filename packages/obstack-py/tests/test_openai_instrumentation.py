"""The OpenAI LLM span, pinned attribute by attribute against the D8 contract.

The assertions compare the span's whole attribute dictionary rather than looking
individual keys up, because both halves of the contract matter: a renamed or
missing key costs ingest a column, and an extra key costs nothing today but is
how a layer attribute or a cost figure the SDK does not own creeps in.
"""

from __future__ import annotations

import asyncio
import json

import fake_provider
import openai
import pytest
from opentelemetry.trace import SpanKind, StatusCode

from obstack.instrumentation import OpenAIInstrumentor

MESSAGES = [
    {"role": "system", "content": "You are the obstack test agent."},
    {"role": "user", "content": "Why did checkout p99 latency jump?"},
]

# Exactly what ingest reads off an LLM span, and nothing else. `finish_reasons`
# is a tuple because the SDK freezes sequence-valued attributes on the way in.
EXPECTED_ATTRIBUTES = {
    "gen_ai.system": "openai",
    "gen_ai.request.model": fake_provider.OPENAI_MODEL,
    "gen_ai.response.model": fake_provider.OPENAI_MODEL,
    "gen_ai.prompt": json.dumps(MESSAGES),
    "gen_ai.completion": fake_provider.OPENAI_ANSWER,
    "gen_ai.usage.input_tokens": fake_provider.OPENAI_INPUT_TOKENS,
    "gen_ai.usage.output_tokens": fake_provider.OPENAI_OUTPUT_TOKENS,
    "gen_ai.response.finish_reasons": (fake_provider.OPENAI_FINISH_REASON,),
}


@pytest.fixture
def instrumented() -> None:
    OpenAIInstrumentor().instrument()


@pytest.fixture
def client(provider_url: str, instrumented: None) -> openai.OpenAI:
    return openai.OpenAI(
        api_key=fake_provider.API_KEY,
        base_url=f"{provider_url}/v1",
        max_retries=0,
    )


@pytest.fixture
def async_client(provider_url: str, instrumented: None) -> openai.AsyncOpenAI:
    return openai.AsyncOpenAI(
        api_key=fake_provider.API_KEY,
        base_url=f"{provider_url}/v1",
        max_retries=0,
    )


def test_sync_completion_carries_the_d8_attributes(client, spans) -> None:
    response = client.chat.completions.create(
        model=fake_provider.OPENAI_MODEL, messages=MESSAGES
    )
    assert response.choices[0].message.content == fake_provider.OPENAI_ANSWER

    span = _one_span(spans)
    assert span.name == f"chat {fake_provider.OPENAI_MODEL}"
    assert span.kind is SpanKind.CLIENT
    assert dict(span.attributes) == EXPECTED_ATTRIBUTES
    # D38 FINAL: ingest does not read span events, so content carried in one
    # would arrive as an empty prompt column with nothing to explain it.
    assert span.events == ()


def test_async_completion_carries_the_d8_attributes(async_client, spans) -> None:
    async def call():
        return await async_client.chat.completions.create(
            model=fake_provider.OPENAI_MODEL, messages=MESSAGES
        )

    response = asyncio.run(call())
    assert response.choices[0].message.content == fake_provider.OPENAI_ANSWER

    span = _one_span(spans)
    assert span.name == f"chat {fake_provider.OPENAI_MODEL}"
    assert span.kind is SpanKind.CLIENT
    assert dict(span.attributes) == EXPECTED_ATTRIBUTES


def test_streaming_is_not_instrumented(client, spans) -> None:
    """The documented gap, measured rather than asserted in prose.

    A streamed completion is consumed after the call returns, so a span closed
    around the call would carry no tokens and ingest would price it at zero. The
    README says these calls produce no span; this is what says it is true.
    """
    chunks = list(
        client.chat.completions.create(
            model=fake_provider.OPENAI_MODEL, messages=MESSAGES, stream=True
        )
    )
    assert "".join(c.choices[0].delta.content or "" for c in chunks) == (
        fake_provider.OPENAI_ANSWER
    )
    assert spans.get_finished_spans() == ()


def test_provider_failure_reaches_the_caller_and_the_span(client, spans) -> None:
    with pytest.raises(openai.APIStatusError):
        client.chat.completions.create(
            model=fake_provider.FAILING_MODEL, messages=MESSAGES
        )

    span = _one_span(spans)
    assert span.status.status_code is StatusCode.ERROR
    assert [event.name for event in span.events] == ["exception"]
    # The request half is still on the span: a failed call is exactly the one a
    # reader wants the prompt of.
    assert span.attributes["gen_ai.prompt"] == json.dumps(MESSAGES)
    assert "gen_ai.completion" not in span.attributes


def test_uninstrument_removes_the_span(client, spans) -> None:
    OpenAIInstrumentor().uninstrument()
    client.chat.completions.create(model=fake_provider.OPENAI_MODEL, messages=MESSAGES)
    assert spans.get_finished_spans() == ()


def _one_span(spans):
    finished = spans.get_finished_spans()
    assert len(finished) == 1, f"expected one LLM span, got {len(finished)}"
    return finished[0]
