"""`obstack.init()` — the second of the two lines an application writes.

Everything here is stock OpenTelemetry assembled in one place: a TracerProvider
and a LoggerProvider, OTLP/HTTP exporters built with no arguments so every knob
comes from the standard `OTEL_*` environment, a root-logger handler so ordinary
`logging.info(...)` calls export correlated with the active span, and the
instrumentations that make the api and llm layers appear. There is no
obstack-specific environment variable and there never should be: an application
that outgrows this function replaces it with its own OTel wiring and keeps every
setting it already had.

Fail-open (PRD §9) is the reason the body sits behind one try/except. An
observability SDK that can take an application down with it — because the
endpoint was mistyped, because an `OTEL_*` value would not parse — has inverted
its own value proposition. When init() fails it warns once and hands back a
handle that does nothing; the application keeps serving, untraced.
"""

from __future__ import annotations

import importlib.util
import logging
import os

from opentelemetry import trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.logging.handler import LoggingHandler
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

from .instrumentation import AnthropicInstrumentor, OpenAIInstrumentor

_log = logging.getLogger(__name__)

# Standard OTel, not obstack's: without it the HTTP instrumentations emit the
# legacy `http.method` rather than the stable `http.request.method` ingest's
# api-layer classifier reads. The api layer itself does not hang on it — that
# classifier takes `http.route` as well, and the instrumentations write the route
# in either mode — so what this default buys is the attribute name the semantic
# conventions settled on, not the layer.
# setdefault, so an application that has already chosen a value keeps it.
_SEMCONV_OPT_IN = "OTEL_SEMCONV_STABILITY_OPT_IN"

# The instrumentations init() turns on, and the import that has to succeed for
# each to be worth turning on. BaseInstrumentor logs at ERROR when its dependency
# is missing, which would mean an application that simply does not use OpenAI
# starts up with an error in its logs; checking first keeps quiet the case that
# is not a problem.
_PROVIDER_INSTRUMENTORS = (
    ("openai", OpenAIInstrumentor),
    ("anthropic", AnthropicInstrumentor),
)

_handle: "Obstack | None" = None


class Obstack:
    """The handle `init()` returns. Owns the two providers it created, if any."""

    def __init__(
        self,
        tracer_provider: TracerProvider | None = None,
        logger_provider: LoggerProvider | None = None,
    ) -> None:
        self._providers = tuple(
            p for p in (tracer_provider, logger_provider) if p is not None
        )

    def shutdown(self) -> None:
        """Flush and stop both pipelines.

        The stock providers already flush at exit, so this is for processes that
        want the last request's telemetry gone before they return — a test, a
        short-lived job, a worker being drained. Calling it on a handle whose
        init() failed does nothing.
        """
        for provider in self._providers:
            try:
                provider.shutdown()
            except Exception:  # noqa: BLE001 — shutdown is not the app's problem
                _log.warning("obstack could not shut down %r", provider, exc_info=True)


def init() -> Obstack:
    """Configure OpenTelemetry for this process and return the obstack handle.

    Idempotent: the second call does nothing and returns the same handle, so a
    module that calls it at import time and a `main()` that calls it again cost
    one pipeline, not two.
    """
    global _handle
    if _handle is not None:
        return _handle
    try:
        _handle = _configure()
    except Exception as exc:  # noqa: BLE001 — fail open, D83
        _log.warning(
            "obstack.init() failed (%s); telemetry is off and the application is "
            "unaffected",
            exc,
            exc_info=True,
        )
        _handle = Obstack()
    return _handle


def _configure() -> Obstack:
    os.environ.setdefault(_SEMCONV_OPT_IN, "http")

    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)

    logger_provider = LoggerProvider()
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(logger_provider)

    # On the root logger, so `logging.info(...)` from anywhere in the application
    # is exported carrying the active span's trace context — the correlation the
    # trace view's logs rail renders. The filter keeps the OTel SDK's own
    # diagnostics out: an export failure logs a warning, and exporting that
    # warning would feed the failure straight back into itself.
    #
    # The bridge handler from opentelemetry-instrumentation-logging, which is
    # where upstream moved it: opentelemetry-sdk 1.44.0 still carries a
    # LoggingHandler but marks it deprecated, and a library that printed a
    # DeprecationWarning into every customer process at init() would be shipping
    # a stopgap. The record it emits is the same one demo/agent-app's handler
    # emits — the parity that matters is the wire shape, not the import path.
    handler = LoggingHandler(logger_provider=logger_provider)
    handler.addFilter(lambda record: not record.name.startswith("opentelemetry"))
    logging.getLogger().addHandler(handler)

    for module, instrumentor in _PROVIDER_INSTRUMENTORS:
        if importlib.util.find_spec(module) is not None:
            instrumentor().instrument(tracer_provider=tracer_provider)
    _instrument_fastapi(tracer_provider)

    return Obstack(tracer_provider, logger_provider)


def _instrument_fastapi(tracer_provider: TracerProvider) -> None:
    """Turn on the api layer, when `obstack-py[fastapi]` is installed.

    Global rather than per-app instrumentation, because the two documented lines
    are all the application writes — there is no `instrument_app(app)` call to
    ask for. It patches FastAPI's constructor, so init() has to run before the
    application object is created.
    """
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    except ImportError:
        _log.debug(
            "obstack: FastAPI instrumentation not installed; no api-layer spans "
            "from this process (install obstack-py[fastapi])"
        )
        return
    FastAPIInstrumentor().instrument(tracer_provider=tracer_provider)
