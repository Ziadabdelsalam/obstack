"""OpenTelemetry wiring for the demo agent (D15).

Deliberately plain: the stock SDK, the stock FastAPI instrumentation, and
exporters constructed with no arguments so every knob comes from the standard
`OTEL_*` environment. Nothing obstack-specific happens here — that is the point
of the demo, which exists to prove the bring-your-own-OTel path works against
the ingest service.
"""

from __future__ import annotations

import logging
from typing import Callable

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor


def configure(app: FastAPI) -> Callable[[], None]:
    """Install the trace and log pipelines and instrument `app`.

    Returns a shutdown function that flushes both batch processors; call it on
    application shutdown or the last request's telemetry never leaves the
    process.
    """
    tracer_provider = TracerProvider()
    tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(tracer_provider)

    logger_provider = LoggerProvider()
    logger_provider.add_log_record_processor(BatchLogRecordProcessor(OTLPLogExporter()))
    set_logger_provider(logger_provider)

    # Attached to the root logger, so plain `logging.info(...)` from anywhere in
    # the app is exported with the active span's trace context attached — the
    # correlation the LogsRail renders. The filter keeps the SDK's own
    # diagnostics out: an export failure logs a warning, and exporting that
    # warning would feed the failure back into itself.
    handler = LoggingHandler(logger_provider=logger_provider)
    handler.addFilter(lambda record: not record.name.startswith("opentelemetry"))
    logging.getLogger().addHandler(handler)

    # The container healthcheck hits /healthz every few seconds; instrumenting
    # it would bury the demo's actual traces under a metronome. The ASGI
    # receive/send spans go too: three extra spans per request that describe the
    # server's own plumbing, not the agent's work.
    FastAPIInstrumentor.instrument_app(
        app,
        tracer_provider=tracer_provider,
        excluded_urls="healthz",
        exclude_spans=["receive", "send"],
    )

    def shutdown() -> None:
        tracer_provider.shutdown()
        logger_provider.shutdown()

    return shutdown
