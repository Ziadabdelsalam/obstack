"""Anthropic messages instrumentation.

The same shape as the OpenAI module, over `Messages.create` and
`AsyncMessages.create`. Two differences are Anthropic's, not obstack's: the
response body is a list of typed content blocks rather than a single string, and
the stop reason is called `stop_reason` — passed through verbatim into the
`gen_ai.response.finish_reasons` array, because normalising provider vocabularies
into a common one would be inventing a fact the provider never stated.

`client.messages.stream(...)` is a different method and is not patched, so it
passes through untraced along with `create(stream=True)`.
"""

from __future__ import annotations

from typing import Any, Callable, Collection

from opentelemetry.instrumentation.instrumentor import BaseInstrumentor
from opentelemetry.instrumentation.utils import unwrap
from opentelemetry.trace import Tracer, get_tracer
from wrapt import wrap_function_wrapper

from .._span import TRACER_NAME
from ..attributes import SYSTEM_ANTHROPIC
from . import _genai

_MODULE = "anthropic.resources.messages"

# The floor is where the Messages API and the `usage.input_tokens` /
# `usage.output_tokens` fields read below settled. Tests run against the version
# pinned in requirements-dev.txt.
_DEPENDENCY = "anthropic >= 0.30.0"


class AnthropicInstrumentor(BaseInstrumentor):
    """D8-conformant spans around the anthropic client's messages calls."""

    def instrumentation_dependencies(self) -> Collection[str]:
        return (_DEPENDENCY,)

    def _instrument(self, **kwargs: Any) -> None:
        tracer = get_tracer(TRACER_NAME, tracer_provider=kwargs.get("tracer_provider"))
        wrap_function_wrapper(_MODULE, "Messages.create", _wrapper(tracer))
        wrap_function_wrapper(_MODULE, "AsyncMessages.create", _awrapper(tracer))

    def _uninstrument(self, **kwargs: Any) -> None:
        from anthropic.resources.messages import AsyncMessages, Messages

        unwrap(Messages, "create")
        unwrap(AsyncMessages, "create")


def _wrapper(tracer: Tracer) -> Callable[..., Any]:
    def wrapper(wrapped, instance, args, kwargs):  # noqa: ANN001 — wrapt's shape
        if kwargs.get("stream"):
            return wrapped(*args, **kwargs)
        return _genai.call(tracer, SYSTEM_ANTHROPIC, _read, wrapped, args, kwargs)

    return wrapper


def _awrapper(tracer: Tracer) -> Callable[..., Any]:
    async def wrapper(wrapped, instance, args, kwargs):  # noqa: ANN001
        if kwargs.get("stream"):
            return await wrapped(*args, **kwargs)
        return await _genai.acall(
            tracer, SYSTEM_ANTHROPIC, _read, wrapped, args, kwargs
        )

    return wrapper


def _read(response: Any) -> _genai.Completion:
    usage = response.usage
    return _genai.Completion(
        model=response.model,
        text="".join(
            block.text
            for block in response.content
            if getattr(block, "type", None) == "text"
        ),
        input_tokens=usage.input_tokens,
        output_tokens=usage.output_tokens,
        finish_reason=response.stop_reason,
    )
