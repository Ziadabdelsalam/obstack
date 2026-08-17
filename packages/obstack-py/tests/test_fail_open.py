"""Fail-open (PRD §9, D83): telemetry failures cost telemetry and nothing else.

Two halves. The subprocess half runs `fail_open_app.py` — two lines of setup, a
real init(), real exporters — under environments that break the telemetry
stack, and checks the application still produced its answer; nothing about that
claim can be tested inside a pytest process that has already installed a working
pipeline. The in-process half breaks the parts a dead endpoint never reaches
because the batch processors swallow them: the tracer itself, and the values
obstack reads on the way into a span — the point where instrumentation can get
between an application and its own provider call.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path

import fake_provider
import openai
import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import Span

import obstack
from obstack.instrumentation import OpenAIInstrumentor

APP = Path(__file__).with_name("fail_open_app.py")

NO_TRACE = "0" * 32


def test_a_dead_endpoint_does_not_break_the_application() -> None:
    """Nothing listens on port 1, so every export attempt fails."""
    result = _run(
        OTEL_EXPORTER_OTLP_ENDPOINT="http://127.0.0.1:1",
        OTEL_EXPORTER_OTLP_TIMEOUT="1",
    )

    assert result.returncode == 0, result.stderr
    answer, trace_id = _parse(result.stdout)
    assert answer == "42"
    # The failure has to be an export failure, not a quiet no-op: a real trace id
    # is the proof that init() succeeded and spans were genuinely handed to an
    # exporter aimed at a closed port.
    assert trace_id != NO_TRACE


def test_unparseable_otel_environment_does_not_break_the_application() -> None:
    """A mistyped standard variable — the exporter reads it as a float."""
    result = _run(OTEL_EXPORTER_OTLP_TIMEOUT="not-a-number")

    assert result.returncode == 0, result.stderr
    answer, trace_id = _parse(result.stdout)
    assert answer == "42"
    # init() gave up, so the application ran on the API's no-op tracer.
    assert trace_id == NO_TRACE
    assert "obstack.init() failed" in result.stderr


def test_a_tracer_that_raises_is_stepped_around(
    monkeypatch: pytest.MonkeyPatch, spans
) -> None:
    @obstack.trace_agent
    def answer_question() -> str:
        return "answered"

    monkeypatch.setattr(trace, "get_tracer", _explode)

    assert answer_question() == "answered"
    assert spans.get_finished_spans() == ()


def test_a_failing_span_end_does_not_lose_the_return_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    @obstack.trace_tool
    def look_up() -> list[str]:
        return ["fact"]

    monkeypatch.setattr(Span, "end", _explode)

    assert look_up() == ["fact"]


def test_a_failing_span_end_does_not_lose_an_async_return_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    @obstack.trace_agent
    async def answer_question() -> str:
        return "answered"

    monkeypatch.setattr(Span, "end", _explode)

    assert asyncio.run(answer_question()) == "answered"


def test_the_applications_exception_wins_over_the_instrumentations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Both fail at once. The one the caller has to see is the application's."""

    @obstack.trace_agent
    def answer_question() -> str:
        raise RuntimeError("the tool is down")

    monkeypatch.setattr(Span, "end", _explode)

    with pytest.raises(RuntimeError, match="the tool is down"):
        answer_question()


class _UnrenderableModel(str):
    """A model name that is a good string right up until something renders it.

    Not a contrivance: `model` is whatever the application handed the client, and
    applications hand it lazily-resolved config objects and proxies. Rendering it
    into the span name is the last thing obstack does before the provider is
    called, which makes it the one place where instrumentation can break an LLM
    call that would otherwise have succeeded.
    """

    def __str__(self) -> str:
        raise RuntimeError("the model name refused to render")

    def __format__(self, spec: str) -> str:
        raise RuntimeError("the model name refused to render")


def test_an_unrenderable_model_name_does_not_break_the_llm_call(
    provider_url: str, spans
) -> None:
    OpenAIInstrumentor().instrument()
    client = openai.OpenAI(
        api_key=fake_provider.API_KEY, base_url=f"{provider_url}/v1", max_retries=0
    )

    response = client.chat.completions.create(
        model=_UnrenderableModel(fake_provider.OPENAI_MODEL),
        messages=[{"role": "user", "content": "why did p99 jump?"}],
    )

    assert response.choices[0].message.content == fake_provider.OPENAI_ANSWER
    # Untraced, not half-traced: obstack stepped aside for the whole call rather
    # than leaving a span it could not finish describing.
    assert spans.get_finished_spans() == ()


def _explode(*args, **kwargs):
    raise AssertionError("the telemetry stack is broken")


def _run(**env: str) -> subprocess.CompletedProcess[str]:
    """Run the sample application with only the given OTEL_* environment."""
    clean = {k: v for k, v in os.environ.items() if not k.startswith("OTEL_")}
    return subprocess.run(
        [sys.executable, str(APP)],
        env={**clean, **env},
        capture_output=True,
        text=True,
        timeout=120,
    )


def _parse(stdout: str) -> tuple[str, str]:
    answer, trace_id = stdout.strip().split()
    return answer.removeprefix("answer="), trace_id.removeprefix("trace_id=")
