"""`@trace_agent` and `@trace_tool`: names, attributes, kind, and nesting.

The span name and the attribute are one fact stated twice — `agent.answer` and
`obstack.agent.step=answer` — because the name is what a human reads in the
trace view and the attribute is what ingest classifies the layer from. Both are
asserted everywhere below; a decorator that set only one would render correctly
and land in the wrong layer, or the reverse.
"""

from __future__ import annotations

import asyncio

import pytest
from opentelemetry.trace import SpanKind, StatusCode

import obstack


def test_bare_decorator_names_the_step_after_the_function(spans) -> None:
    @obstack.trace_agent
    def answer_question() -> str:
        return "answered"

    assert answer_question() == "answered"

    span = _one_span(spans)
    assert span.name == "agent.answer_question"
    assert dict(span.attributes) == {"obstack.agent.step": "answer_question"}
    assert span.kind is SpanKind.INTERNAL


def test_explicit_name_overrides_the_function_name(spans) -> None:
    @obstack.trace_agent("plan")
    def answer_question() -> str:
        return "answered"

    span = _run_and_take(answer_question, spans)
    assert span.name == "agent.plan"
    assert dict(span.attributes) == {"obstack.agent.step": "plan"}


def test_called_decorator_without_a_name_still_uses_the_function_name(spans) -> None:
    @obstack.trace_agent()
    def answer_question() -> str:
        return "answered"

    span = _run_and_take(answer_question, spans)
    assert span.name == "agent.answer_question"


def test_tool_decorator_uses_the_tool_vocabulary(spans) -> None:
    @obstack.trace_tool("knowledge_lookup")
    def look_up() -> list[str]:
        return ["fact"]

    span = _run_and_take(look_up, spans)
    assert span.name == "tool.knowledge_lookup"
    assert dict(span.attributes) == {"obstack.tool.name": "knowledge_lookup"}
    assert span.kind is SpanKind.INTERNAL


def test_async_functions_are_traced_around_the_await(spans) -> None:
    @obstack.trace_agent
    async def answer_question() -> str:
        await asyncio.sleep(0)
        return "answered"

    assert asyncio.run(answer_question()) == "answered"

    span = _one_span(spans)
    assert span.name == "agent.answer_question"
    assert dict(span.attributes) == {"obstack.agent.step": "answer_question"}


def test_the_decorated_function_still_looks_like_itself() -> None:
    @obstack.trace_tool
    def look_up(question: str) -> str:
        """Find something."""
        return question

    assert look_up.__name__ == "look_up"
    assert look_up.__doc__ == "Find something."
    assert look_up("q") == "q"


def test_a_tool_call_inside_an_agent_step_nests(spans) -> None:
    @obstack.trace_tool("knowledge_lookup")
    def look_up() -> list[str]:
        return ["fact"]

    @obstack.trace_agent("answer_question")
    def answer() -> list[str]:
        return look_up()

    answer()

    tool, agent = spans.get_finished_spans()
    assert (tool.name, agent.name) == ("tool.knowledge_lookup", "agent.answer_question")
    assert tool.parent.span_id == agent.context.span_id
    assert tool.context.trace_id == agent.context.trace_id


def test_an_application_exception_propagates_and_is_recorded(spans) -> None:
    @obstack.trace_agent
    def answer_question() -> str:
        raise RuntimeError("the tool is down")

    with pytest.raises(RuntimeError, match="the tool is down"):
        answer_question()

    span = _one_span(spans)
    assert span.status.status_code is StatusCode.ERROR
    assert [event.name for event in span.events] == ["exception"]


def _run_and_take(fn, spans):
    fn()
    return _one_span(spans)


def _one_span(spans):
    finished = spans.get_finished_spans()
    assert len(finished) == 1, f"expected one span, got {len(finished)}"
    return finished[0]
