"""OpenAI chat-completions instrumentation.

Patches the two methods the openai client funnels every chat completion through,
`Completions.create` and `AsyncCompletions.create`, so an application that keeps
writing plain `client.chat.completions.create(...)` gets the D8 LLM span without
a line of telemetry code.

Written here rather than taken from otel-contrib on purpose (D77): the upstream
GenAI instrumentations put prompt and completion in span *events*, a wire form
obstack's ingest deliberately does not read, so their spans would land in
ClickHouse with the content columns empty.
"""

from __future__ import annotations

from typing import Any, Callable, Collection

from opentelemetry.instrumentation.instrumentor import BaseInstrumentor
from opentelemetry.instrumentation.utils import unwrap
from opentelemetry.trace import Tracer, get_tracer
from wrapt import wrap_function_wrapper

from .._span import TRACER_NAME
from ..attributes import SYSTEM_OPENAI
from . import _genai

# Both classes are re-exported from the package, and both are the same objects
# the client instantiates, so patching them covers every openai client in the
# process regardless of how it was constructed.
_MODULE = "openai.resources.chat.completions"

# The floor is openai-python's v1 rewrite, which is where
# `client.chat.completions.create` and the typed response objects read below
# first appear. Tests run against the version pinned in requirements-dev.txt.
_DEPENDENCY = "openai >= 1.0.0"


class OpenAIInstrumentor(BaseInstrumentor):
    """D8-conformant spans around the openai client's chat completions."""

    def instrumentation_dependencies(self) -> Collection[str]:
        return (_DEPENDENCY,)

    def _instrument(self, **kwargs: Any) -> None:
        tracer = get_tracer(TRACER_NAME, tracer_provider=kwargs.get("tracer_provider"))
        wrap_function_wrapper(_MODULE, "Completions.create", _wrapper(tracer))
        wrap_function_wrapper(_MODULE, "AsyncCompletions.create", _awrapper(tracer))

    def _uninstrument(self, **kwargs: Any) -> None:
        from openai.resources.chat.completions import AsyncCompletions, Completions

        unwrap(Completions, "create")
        unwrap(AsyncCompletions, "create")


def _wrapper(tracer: Tracer) -> Callable[..., Any]:
    def wrapper(wrapped, instance, args, kwargs):  # noqa: ANN001 — wrapt's shape
        # A streamed completion is consumed long after this call returns, so a
        # span closed here would carry no token counts and ingest would price it
        # at zero. Passing it through untraced leaves a gap; instrumenting it
        # would leave a wrong number, which is worse.
        if kwargs.get("stream"):
            return wrapped(*args, **kwargs)
        return _genai.call(tracer, SYSTEM_OPENAI, _read, wrapped, args, kwargs)

    return wrapper


def _awrapper(tracer: Tracer) -> Callable[..., Any]:
    async def wrapper(wrapped, instance, args, kwargs):  # noqa: ANN001
        if kwargs.get("stream"):
            return await wrapped(*args, **kwargs)
        return await _genai.acall(tracer, SYSTEM_OPENAI, _read, wrapped, args, kwargs)

    return wrapper


def _read(response: Any) -> _genai.Completion:
    choice = response.choices[0]
    usage = response.usage
    return _genai.Completion(
        model=response.model,
        text=choice.message.content or "",
        input_tokens=usage.prompt_tokens,
        output_tokens=usage.completion_tokens,
        finish_reason=choice.finish_reason,
    )
