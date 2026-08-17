"""What `obstack.init()` configures, and what it refuses to configure twice."""

from __future__ import annotations

import logging
import os
from typing import Iterator

import pytest
from opentelemetry.instrumentation.logging.handler import LoggingHandler

import obstack
from obstack.instrumentation import AnthropicInstrumentor, OpenAIInstrumentor


@pytest.fixture(autouse=True)
def _isolated_process_state(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Keep init()'s process-wide effects inside the test that caused them.

    init() points exporters at whatever the environment says and hangs a handler
    on the root logger; without this the rest of the session would keep trying to
    ship its own pytest logs to a real endpoint. The endpoint here is a closed
    port, so the batch processors have somewhere to fail against rather than
    something to reach.
    """
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:1")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_TIMEOUT", "1")
    monkeypatch.delenv("OTEL_SEMCONV_STABILITY_OPT_IN", raising=False)
    root = logging.getLogger()
    handlers = list(root.handlers)
    yield
    root.handlers = handlers


def test_init_returns_a_handle_that_shuts_down() -> None:
    handle = obstack.init()

    assert isinstance(handle, obstack.Obstack)
    handle.shutdown()
    # Draining twice is what a process does when it calls shutdown() and then
    # exits into the providers' own atexit flush.
    handle.shutdown()


def test_init_is_idempotent() -> None:
    first = obstack.init()
    second = obstack.init()

    assert first is second
    first.shutdown()


def test_init_opts_into_stable_http_semantic_conventions() -> None:
    """Without this the api layer disappears: FastAPI emits the legacy
    `http.method`, and ingest classifies on `http.request.method`."""
    handle = obstack.init()
    try:
        assert os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"] == "http"
    finally:
        handle.shutdown()


def test_init_does_not_override_a_chosen_semconv_opt_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("OTEL_SEMCONV_STABILITY_OPT_IN", "http/dup")

    handle = obstack.init()
    try:
        assert os.environ["OTEL_SEMCONV_STABILITY_OPT_IN"] == "http/dup"
    finally:
        handle.shutdown()


def test_init_exports_application_logs_but_not_opentelemetry_s_own() -> None:
    """The filter is what stops an export failure from being exported.

    OTel's exporters report their own failures through `logging`; a root handler
    without this filter would turn each failure into a log record that fails to
    export, which logs a failure, and so on.
    """
    handle = obstack.init()
    try:
        handlers = [
            h for h in logging.getLogger().handlers if isinstance(h, LoggingHandler)
        ]
        assert len(handlers) == 1, "init() should install exactly one log handler"
        handler = handlers[0]

        assert handler.filter(_record("myapp.orders"))
        assert not handler.filter(_record("opentelemetry.sdk.trace.export"))
    finally:
        handle.shutdown()


def test_init_turns_on_the_provider_instrumentations() -> None:
    """openai and anthropic are both installed in the test environment, so both
    instrumentors are expected to be live; an application without them gets the
    quiet skip instead, which is why init() checks importability itself."""
    handle = obstack.init()
    try:
        assert OpenAIInstrumentor().is_instrumented_by_opentelemetry
        assert AnthropicInstrumentor().is_instrumented_by_opentelemetry
    finally:
        handle.shutdown()


def test_init_turns_on_fastapi_when_the_extra_is_installed() -> None:
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    handle = obstack.init()
    try:
        assert FastAPIInstrumentor().is_instrumented_by_opentelemetry
    finally:
        handle.shutdown()


def _record(name: str) -> logging.LogRecord:
    return logging.LogRecord(name, logging.INFO, __file__, 1, "message", None, None)
