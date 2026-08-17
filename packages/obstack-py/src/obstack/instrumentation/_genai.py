"""The D8 LLM span, shared by every provider instrumentation.

Both providers describe the same call — some messages go out, some text and a
token count come back — in their own object model. Each instrumentation module
reduces its response to `Completion` below; everything about the span itself,
including which attribute names are used and how a failure is handled, is
decided once, here.

Content capture is on and complete: the whole prompt, the whole completion, no
truncation and no opt-out. That is the product — a trace of an agent whose LLM
calls are redacted answers no question anyone opens obstack to ask.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Any, Callable

from opentelemetry.trace import SpanKind, Tracer

from .._span import Scope
from ..attributes import (
    GEN_AI_COMPLETION,
    GEN_AI_FINISH_REASONS,
    GEN_AI_INPUT_TOKENS,
    GEN_AI_OUTPUT_TOKENS,
    GEN_AI_PROMPT,
    GEN_AI_REQUEST_MODEL,
    GEN_AI_RESPONSE_MODEL,
    GEN_AI_SYSTEM,
)

_log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Completion:
    """What a provider response contributes to the span, provider-independently."""

    model: str | None
    text: str
    input_tokens: int
    output_tokens: int
    finish_reason: str | None


# Turns one provider's response object into a Completion. Called inside the
# span's own error handling, so it may index and attribute-access freely.
Reader = Callable[[Any], Completion]


def call(
    tracer: Tracer,
    system: str,
    read: Reader,
    wrapped: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> Any:
    """Run a synchronous provider call inside one LLM span."""
    with _span(tracer, system, kwargs) as scope:
        response = wrapped(*args, **kwargs)
        _record(scope, kwargs, read, response)
        return response


async def acall(
    tracer: Tracer,
    system: str,
    read: Reader,
    wrapped: Callable[..., Any],
    args: tuple[Any, ...],
    kwargs: dict[str, Any],
) -> Any:
    """Run an asynchronous provider call inside one LLM span."""
    with _span(tracer, system, kwargs) as scope:
        response = await wrapped(*args, **kwargs)
        _record(scope, kwargs, read, response)
        return response


def _span(tracer: Tracer, system: str, kwargs: dict[str, Any]) -> Scope:
    model = kwargs.get("model")
    attributes: dict[str, Any] = {GEN_AI_SYSTEM: system}
    if model:
        attributes[GEN_AI_REQUEST_MODEL] = model
    prompt = _prompt(kwargs.get("messages"))
    if prompt is not None:
        attributes[GEN_AI_PROMPT] = prompt
    # CLIENT because the span covers a call leaving this process for a model
    # provider; `chat <model>` is the span name the GenAI conventions specify and
    # the one demo/agent-app already produces, so an obstack trace reads the same
    # whichever produced it.
    return Scope(_name(model), SpanKind.CLIENT, attributes, tracer=tracer)


def _name(model: Any) -> str:
    return f"chat {model}" if model else "chat"


def _prompt(messages: Any) -> str | None:
    """The request's messages array as a JSON string, in the order sent."""
    if messages is None:
        return None
    try:
        # default=str so a provider's typed message object cannot turn a
        # serialisation edge case into a lost span; the fallback is the repr,
        # which is still the content a reader wants to see.
        return json.dumps(messages, default=str)
    except Exception:  # noqa: BLE001
        _log.warning("obstack could not serialise the request messages", exc_info=True)
        return None


def _record(scope: Scope, kwargs: dict[str, Any], read: Reader, response: Any) -> None:
    try:
        completion = read(response)
    except Exception:  # noqa: BLE001
        # A provider that changed its response shape costs the response half of
        # the attributes. It does not cost the caller their answer.
        _log.warning("obstack could not read the provider response", exc_info=True)
        return

    scope.set(GEN_AI_RESPONSE_MODEL, completion.model or kwargs.get("model"))
    scope.set(GEN_AI_COMPLETION, completion.text)
    scope.set(GEN_AI_INPUT_TOKENS, completion.input_tokens)
    scope.set(GEN_AI_OUTPUT_TOKENS, completion.output_tokens)
    if completion.finish_reason:
        # The semantic conventions' array form, single element. D8's amendment
        # accepts it or the scalar; ingest takes element [0] either way.
        scope.set(GEN_AI_FINISH_REASONS, [completion.finish_reason])
