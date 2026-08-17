"""Shared fixtures: one in-memory tracing pipeline, one clean global state.

The SDK's public surface talks to process globals — the tracer provider, the
root logger, the instrumentor singletons — so the fixtures here exist to make
each test see the same starting point as the first one.
"""

from __future__ import annotations

import importlib.util
from typing import Iterator

import fake_provider
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from obstack import _sdk
from obstack.instrumentation import AnthropicInstrumentor, OpenAIInstrumentor


@pytest.fixture(scope="session", autouse=True)
def _tracing() -> Iterator[InMemorySpanExporter]:
    """Install the process's one tracer provider, exporting to memory.

    OpenTelemetry allows the global provider to be set once and ignores every
    later attempt, so this has to win the race against any init() a test makes —
    hence autouse and session scope. The assertion is the difference between a
    suite that checks attributes and a suite that checks nothing: if something
    else got there first, every span assertion below would be made against an
    exporter no span can ever reach.
    """
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    assert trace.get_tracer_provider() is provider, (
        "another tracer provider was installed before the test session started; "
        "spans would go there and every assertion in this suite would pass "
        "against an empty exporter"
    )
    yield exporter
    provider.shutdown()


@pytest.fixture
def spans(_tracing: InMemorySpanExporter) -> InMemorySpanExporter:
    """The in-memory exporter, emptied so a test sees only its own spans."""
    _tracing.clear()
    return _tracing


@pytest.fixture(autouse=True)
def _clean_globals() -> Iterator[None]:
    """Undo instrumentation and init()'s memory of itself after every test."""
    yield
    _sdk._handle = None
    instrumentors = [OpenAIInstrumentor(), AnthropicInstrumentor()]
    if importlib.util.find_spec("opentelemetry.instrumentation.fastapi") is not None:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        instrumentors.append(FastAPIInstrumentor())
    for instrumentor in instrumentors:
        if instrumentor.is_instrumented_by_opentelemetry:
            instrumentor.uninstrument()


@pytest.fixture(scope="session")
def provider_url() -> Iterator[str]:
    """Base URL of the local OpenAI/Anthropic-compatible endpoint."""
    yield from fake_provider.serve()
