"""`@trace_agent` and `@trace_tool` — the two spans an application writes by hand.

Everything else obstack emits is observed: the HTTP server span comes from the
framework instrumentation, the LLM span from the patched provider client. The
agent and tool layers have no library to patch — only the application knows that
this function is a reasoning step and that one is a tool call — so they are the
one place the SDK asks for a line of code, and the decorators keep that line to
its smallest possible form.

Neither decorator captures arguments or return values. Doing so is the obvious
next feature and the obvious way to ship a silent PII leak: the values that flow
through an agent step are exactly the customer data nobody agreed to send to an
observability backend. It stays unshipped until it is ruled on, with a toggle,
rather than arriving by default.
"""

from __future__ import annotations

import functools
import inspect
from typing import Any, Callable, TypeVar, Union, overload

from opentelemetry.trace import SpanKind

from ._span import Scope
from .attributes import AGENT_STEP, TOOL_NAME

F = TypeVar("F", bound=Callable[..., Any])

# What a decorator is handed: the function directly (`@trace_agent`), a name
# (`@trace_agent("answer")`), or nothing (`@trace_agent()`).
Target = Union[str, Callable[..., Any], None]


@overload
def trace_agent(target: F) -> F: ...
@overload
def trace_agent(target: str | None = None) -> Callable[[F], F]: ...


def trace_agent(target: Target = None) -> Any:
    """Record the decorated function as an agent step.

    Emits an INTERNAL span named `agent.<step>` carrying
    `obstack.agent.step=<step>`, which is what makes ingest classify it into the
    agent layer. `step` defaults to the function's own name; pass one to
    override it: both `@trace_agent` and `@trace_agent("answer_question")` are
    valid. Sync and async functions are both supported.
    """
    return _decorate(target, "agent.", AGENT_STEP)


@overload
def trace_tool(target: F) -> F: ...
@overload
def trace_tool(target: str | None = None) -> Callable[[F], F]: ...


def trace_tool(target: Target = None) -> Any:
    """Record the decorated function as a tool call.

    Emits an INTERNAL span named `tool.<name>` carrying
    `obstack.tool.name=<name>`, the tool layer's classifier. Same shape as
    `trace_agent`: the name defaults to the function's, sync and async both
    work.
    """
    return _decorate(target, "tool.", TOOL_NAME)


def _decorate(target: Target, prefix: str, attribute: str) -> Any:
    """Resolve the bare-vs-named decorator forms into a wrapped function."""
    if callable(target):
        return _wrap(target, target.__name__, prefix, attribute)

    def decorator(fn: F) -> F:
        return _wrap(fn, target or fn.__name__, prefix, attribute)

    return decorator


def _wrap(fn: F, step: str, prefix: str, attribute: str) -> F:
    name = f"{prefix}{step}"
    attributes = {attribute: step}

    # Two wrappers rather than one that inspects at call time: an `async def`
    # wrapped by a sync function returns a coroutine the caller has to await
    # anyway, and the span would close before the body ever ran.
    if inspect.iscoroutinefunction(fn):

        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            with Scope(name, SpanKind.INTERNAL, attributes):
                return await fn(*args, **kwargs)

        return async_wrapper  # type: ignore[return-value]

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        with Scope(name, SpanKind.INTERNAL, attributes):
            return fn(*args, **kwargs)

    return wrapper  # type: ignore[return-value]
