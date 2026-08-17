"""One span's lifetime, with every telemetry failure absorbed (D83).

The fail-open rule the PRD states for the SDK as a whole comes down to a single
question at every span: what happens when the telemetry stack misbehaves while
the application's own code is mid-call. `with tracer.start_as_current_span(...)`
answers it badly — a tracer that raises on acquisition takes the call site with
it, and an exporter that raises inside `span.end()` turns a successful function
into a failed one, because the exception escapes from the `with` statement's
exit and the return value is never reached.

`Scope` is the same idiom with those two edges closed. Entering never raises and
may produce no span at all; exiting never raises and never swallows, so the
application's exception propagates exactly as it would have without obstack and
its return value survives a broken exporter.
"""

from __future__ import annotations

import logging
from typing import Any, Mapping

from opentelemetry import trace
from opentelemetry.trace import SpanKind, Tracer

_log = logging.getLogger(__name__)

# The instrumentation scope every obstack span is attributed to.
TRACER_NAME = "obstack"


class Scope:
    """A context manager over one span. Never raises out of enter or exit."""

    def __init__(
        self,
        name: str,
        kind: SpanKind,
        attributes: Mapping[str, Any],
        tracer: Tracer | None = None,
    ) -> None:
        self._name = name
        self._kind = kind
        self._attributes = attributes
        # Instrumentors hold a tracer bound to init()'s provider; the decorators
        # pass none and resolve globally at call time, because the application
        # is free to call init() long after `import obstack` ran.
        self._tracer = tracer
        self._cm: Any = None
        self.span: trace.Span | None = None

    def __enter__(self) -> "Scope":
        try:
            tracer = self._tracer or trace.get_tracer(TRACER_NAME)
            self._cm = tracer.start_as_current_span(
                self._name, kind=self._kind, attributes=dict(self._attributes)
            )
            self.span = self._cm.__enter__()
        except Exception:  # noqa: BLE001 — the whole point is to catch everything
            _log.warning(
                "obstack could not start span %r; the call runs untraced",
                self._name,
                exc_info=True,
            )
            self._cm = None
            self.span = None
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if self._cm is not None:
            try:
                # The stock context manager records the exception and sets status
                # ERROR on the way out, then declines to suppress it — which is
                # what D83 asks for. Only its own failures are caught here.
                self._cm.__exit__(exc_type, exc, tb)
            except Exception:  # noqa: BLE001
                _log.warning(
                    "obstack could not finish span %r; the call is unaffected",
                    self._name,
                    exc_info=True,
                )
        # Always False: an exception raised by the wrapped code belongs to the
        # application, and instrumentation that swallowed it would be a bug far
        # worse than a missing span.
        return False

    def set(self, key: str, value: Any) -> None:
        """Set one attribute, or nothing at all when telemetry is unavailable."""
        if self.span is None or value is None:
            return
        try:
            self.span.set_attribute(key, value)
        except Exception:  # noqa: BLE001
            _log.warning("obstack could not set attribute %r", key, exc_info=True)
