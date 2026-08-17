import { SpanStatusCode, diag, type Span } from "@opentelemetry/api";

/**
 * The one rule this SDK will not bend (D83, PRD §9): observability is never
 * allowed to break the thing it observes. Every place obstack-js could throw
 * into application code routes through here instead — the caller then does the
 * un-instrumented thing (call the function directly, skip the attribute, return
 * the value it already has).
 *
 * `diag` rather than `console`: these are per-call sites, and a broken
 * dependency would turn a warning into a log flood the app cannot silence.
 * Apps that want to see them register a diag logger, which is the standard OTel
 * knob. `init()` is the exception and warns on the console directly — it fires
 * at most once per process, and a silently disabled SDK is worse than noise.
 */
export function swallowed(what: string, error: unknown): void {
  diag.warn(`obstack: ${what} failed and was ignored (telemetry only)`, error);
}

/**
 * An application exception is evidence, not noise: it is recorded on the span
 * and sets the status to ERROR. It is never swallowed — the caller re-throws it
 * untouched. Only the recording itself can fail here, and that is ignored.
 */
export function recordFailure(span: Span, error: unknown): void {
  try {
    span.recordException(error instanceof Error ? error : String(error));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  } catch (failure) {
    swallowed("recording an exception on a span", failure);
  }
}

/** Ends a span, or gives up on it. Either way the caller's value survives. */
export function endSpan(span: Span): void {
  try {
    span.end();
  } catch (error) {
    swallowed("ending a span", error);
  }
}
