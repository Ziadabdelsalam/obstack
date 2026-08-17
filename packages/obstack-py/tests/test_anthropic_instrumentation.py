"""The Anthropic LLM span, pinned the same way as the OpenAI one.

Anthropic is unit-level coverage this sprint (D77(e)): the client is real and so
is the round trip, but the end-to-end ClickHouse proof runs on the OpenAI leg.
The two things that differ from OpenAI are asserted explicitly — the response's
text blocks are joined into the single string a reader sees, and `stop_reason`
is passed through verbatim instead of being translated into OpenAI's vocabulary.
"""

from __future__ import annotations

import asyncio
import json

import anthropic
import fake_provider
import pytest
from opentelemetry.trace import SpanKind

from obstack.instrumentation import AnthropicInstrumentor

MESSAGES = [{"role": "user", "content": "Did the last deploy change the error rate?"}]

EXPECTED_ATTRIBUTES = {
    "gen_ai.system": "anthropic",
    "gen_ai.request.model": fake_provider.ANTHROPIC_MODEL,
    "gen_ai.response.model": fake_provider.ANTHROPIC_MODEL,
    "gen_ai.prompt": json.dumps(MESSAGES),
    "gen_ai.completion": fake_provider.ANTHROPIC_ANSWER,
    "gen_ai.usage.input_tokens": fake_provider.ANTHROPIC_INPUT_TOKENS,
    "gen_ai.usage.output_tokens": fake_provider.ANTHROPIC_OUTPUT_TOKENS,
    # Anthropic's own word for why it stopped, not a normalised one.
    "gen_ai.response.finish_reasons": (fake_provider.ANTHROPIC_STOP_REASON,),
}


@pytest.fixture
def instrumented() -> None:
    AnthropicInstrumentor().instrument()


@pytest.fixture
def client(provider_url: str, instrumented: None) -> anthropic.Anthropic:
    return anthropic.Anthropic(
        api_key=fake_provider.API_KEY, base_url=provider_url, max_retries=0
    )


@pytest.fixture
def async_client(provider_url: str, instrumented: None) -> anthropic.AsyncAnthropic:
    return anthropic.AsyncAnthropic(
        api_key=fake_provider.API_KEY, base_url=provider_url, max_retries=0
    )


def test_sync_message_carries_the_d8_attributes(client, spans) -> None:
    response = client.messages.create(
        model=fake_provider.ANTHROPIC_MODEL, max_tokens=256, messages=MESSAGES
    )
    assert response.content[0].text == fake_provider.ANTHROPIC_ANSWER

    span = _one_span(spans)
    assert span.name == f"chat {fake_provider.ANTHROPIC_MODEL}"
    assert span.kind is SpanKind.CLIENT
    assert dict(span.attributes) == EXPECTED_ATTRIBUTES
    assert span.events == ()


def test_async_message_carries_the_d8_attributes(async_client, spans) -> None:
    async def call():
        return await async_client.messages.create(
            model=fake_provider.ANTHROPIC_MODEL, max_tokens=256, messages=MESSAGES
        )

    response = asyncio.run(call())
    assert response.content[0].text == fake_provider.ANTHROPIC_ANSWER

    span = _one_span(spans)
    assert dict(span.attributes) == EXPECTED_ATTRIBUTES


def test_uninstrument_removes_the_span(client, spans) -> None:
    AnthropicInstrumentor().uninstrument()
    client.messages.create(
        model=fake_provider.ANTHROPIC_MODEL, max_tokens=256, messages=MESSAGES
    )
    assert spans.get_finished_spans() == ()


def _one_span(spans):
    finished = spans.get_finished_spans()
    assert len(finished) == 1, f"expected one LLM span, got {len(finished)}"
    return finished[0]
