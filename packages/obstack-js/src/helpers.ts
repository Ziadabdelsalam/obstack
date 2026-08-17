import { SpanKind, trace, type Span } from "@opentelemetry/api";
import { OBSTACK_AGENT_STEP, OBSTACK_TOOL_NAME, agentSpanName, toolSpanName } from "./attributes";
import { endSpan, recordFailure, swallowed } from "./fail-open";
import { SDK_NAME, SDK_VERSION } from "./scope";

/**
 * The two spans an agent app has to draw itself, because no library can infer
 * them: which step of the agent is running, and which tool it reached for.
 * The other two layers of the four-layer trace (api, llm) are auto-instrumented
 * by `init()`.
 *
 * Both take the function and run it immediately — the `startActiveSpan` shape —
 * so the step's own work, the LLM call inside it and any HTTP the tool makes all
 * nest underneath without the caller threading a context anywhere.
 */

/**
 * Runs `fn` as an agent step: span `agent.<step>`, attribute
 * `obstack.agent.step`, kind INTERNAL. Sync or async — a returned promise is
 * awaited before the span ends, so the duration is the real one.
 */
export function traceAgent<T>(step: string, fn: () => T | Promise<T>): T | Promise<T> {
  return inSpan(agentSpanName(step), OBSTACK_AGENT_STEP, step, fn);
}

/**
 * Runs `fn` as a tool call: span `tool.<name>`, attribute `obstack.tool.name`,
 * kind INTERNAL. Same shape as {@link traceAgent}.
 */
export function traceTool<T>(name: string, fn: () => T | Promise<T>): T | Promise<T> {
  return inSpan(toolSpanName(name), OBSTACK_TOOL_NAME, name, fn);
}

/**
 * Neither helper captures arguments or return values. That would be the obvious
 * next feature and it is deliberately not here: what an agent step receives is
 * arbitrary application data, and quietly shipping it to a telemetry backend is
 * a PII decision nobody has taken. LLM prompts and completions ARE captured, in
 * full — see the README; that one is the product, and it says so out loud.
 */
function inSpan<T>(
  spanName: string,
  attribute: string,
  value: string,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  let tracer;
  try {
    tracer = trace.getTracer(SDK_NAME, SDK_VERSION);
  } catch (error) {
    swallowed(`tracer lookup for ${spanName}`, error);
    return fn();
  }

  // `entered` separates the two failures that both surface as a throw out of
  // startActiveSpan: the tracer failing to give us a span (ours — fail open and
  // run the function un-instrumented) and the application's own exception
  // (never ours to touch — propagate it exactly as thrown).
  let entered = false;
  try {
    return tracer.startActiveSpan(
      spanName,
      { kind: SpanKind.INTERNAL, attributes: { [attribute]: value } },
      (span) => {
        entered = true;
        return runInside(span, fn);
      },
    );
  } catch (error) {
    if (entered) throw error;
    swallowed(`starting span ${spanName}`, error);
    return fn();
  }
}

/**
 * Runs the application's function with the span open. The application's result
 * — value or exception — is what leaves this function, always: span
 * finalisation happens on the side and its own failures are swallowed, so a
 * broken exporter cannot turn a working request into a 500.
 */
function runInside<T>(span: Span, fn: () => T | Promise<T>): T | Promise<T> {
  let result: T | Promise<T>;
  try {
    result = fn();
  } catch (error) {
    recordFailure(span, error);
    endSpan(span);
    throw error;
  }

  if (isThenable(result)) {
    return result.then(
      (value) => {
        endSpan(span);
        return value;
      },
      (error: unknown) => {
        recordFailure(span, error);
        endSpan(span);
        throw error;
      },
    );
  }

  endSpan(span);
  return result;
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as Promise<T> | undefined)?.then === "function";
}
