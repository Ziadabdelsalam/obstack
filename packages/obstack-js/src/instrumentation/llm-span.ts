import { SpanKind, context, trace, type Span, type Tracer } from "@opentelemetry/api";
import {
  GEN_AI_COMPLETION,
  GEN_AI_FINISH_REASONS,
  GEN_AI_INPUT_TOKENS,
  GEN_AI_OUTPUT_TOKENS,
  GEN_AI_PROMPT,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  llmSpanName,
} from "../attributes";
import { endSpan, recordFailure, swallowed } from "../fail-open";

/**
 * The span half of the OpenAI and Anthropic instrumentations. Both providers
 * expose the same thing behind different field names — one request, one
 * response, one completion — so the wire shapes are described per provider (in
 * `openai.ts` / `anthropic.ts`) and the span lifecycle, D8 emission and
 * fail-open behaviour are written once, here.
 *
 * The emission itself is D82: kind CLIENT (this span covers a call OUT to a
 * model provider, not work done in this process), name `chat <model>`,
 * finish reason as a single-element array, no cost attribute (D9 — ingest
 * computes it), no span events (D38 FINAL — ingest does not read them).
 */

/** A provider request reduced to what D8 asks for. */
export interface LlmRequest {
  /** `gen_ai.system` — "openai" or "anthropic". */
  readonly system: string;
  /** The model the caller asked for. */
  readonly model: string;
  /** The messages array as a JSON string, in the order the caller sent it. */
  readonly prompt: string;
}

/** A provider response reduced to what D8 asks for. */
export interface LlmResponse {
  /** The model the provider says answered; falls back to the requested one. */
  readonly model: string;
  /** The assistant's reply as plain text — the thing a person reads. */
  readonly completion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Provider-native, passed through verbatim; "" when the provider omitted it. */
  readonly finishReason: string;
}

/** How one provider's `create()` maps onto the two shapes above. */
export interface LlmShape {
  /**
   * Returns undefined to leave the call alone. That is the honest answer for a
   * streaming request — this sprint does not instrument streaming, and a
   * gen_ai span with zero tokens would misprice to $0 rather than be absent.
   */
  request(args: readonly unknown[]): LlmRequest | undefined;
  response(body: unknown, request: LlmRequest): LlmResponse | undefined;
}

type Create = (...args: unknown[]) => unknown;

/**
 * Turns the value `create()` returned into the thenable the span should watch.
 * Returns undefined when it cannot watch this value at all, having said so
 * itself through `swallowed()` — the caller then leaves the application's value
 * completely alone.
 *
 * This exists because on one path — `openai`'s Responses API — watching the
 * returned promise is exactly the wrong thing to do: reading it first breaks the
 * application's own read (see `observeResponsesBody` in `openai.ts`). The span
 * has to be fed from a different thenable than the one handed back. That is an
 * `openai` fact, so the knowledge lives there; only the ability to watch
 * something else lives here.
 */
type Observe = (result: unknown) => PromiseLike<unknown> | undefined;

/**
 * Wraps one `create()` call in an LLM span. The provider's own return value is
 * what comes back — deliberately the *same object*, not a promise chained off
 * it: `openai` and `@anthropic-ai/sdk` both return an `APIPromise`, whose
 * `.withResponse()` / `.asResponse()` an application may be using.
 *
 * By default the span observes that promise directly, which is safe for
 * `chat.completions.create` and `messages.create`: both hand back the base
 * `APIPromise`, whose `.then()` parses once and memoises, so watching it costs
 * nothing and consumes nothing. Callers whose promise does not behave that way
 * pass `observe` and the span watches whatever that returns instead.
 */
export function traceLlmCall(
  tracer: Tracer,
  shape: LlmShape,
  original: Create,
  thisArg: unknown,
  args: unknown[],
  observe?: Observe,
): unknown {
  let request: LlmRequest | undefined;
  try {
    request = shape.request(args);
  } catch (error) {
    swallowed("reading an LLM request", error);
  }
  if (!request) return original.apply(thisArg, args);

  let span;
  try {
    span = tracer.startSpan(llmSpanName(request.model), {
      kind: SpanKind.CLIENT,
      attributes: {
        [GEN_AI_SYSTEM]: request.system,
        [GEN_AI_REQUEST_MODEL]: request.model,
        [GEN_AI_PROMPT]: request.prompt,
      },
    });
  } catch (error) {
    swallowed("starting an LLM span", error);
    return original.apply(thisArg, args);
  }

  let result: unknown;
  try {
    // The call runs inside the span's context so the provider library's own
    // HTTP span (instrumentation-http is always on) nests under it.
    result = context.with(trace.setSpan(context.active(), span), () =>
      original.apply(thisArg, args),
    );
  } catch (error) {
    recordFailure(span, error);
    endSpan(span);
    throw error;
  }

  let observed: PromiseLike<unknown> | undefined;
  if (observe) {
    // Says so itself when it cannot watch this value — one `swallowed()`, not a
    // second one here.
    observed = observe(result);
  } else if (isThenable(result)) {
    observed = result;
  } else {
    swallowed("observing an LLM call", new Error("create() did not return a promise"));
  }

  if (!observed) {
    // Nothing to watch. The span cannot be un-started — it has to exist BEFORE
    // the call so the provider's HTTP span nests under it — so it is ended here
    // carrying the request half only, rather than left open forever. The
    // application's own value is returned untouched, which is the part that
    // matters: the call itself is unaffected either way (D83).
    endSpan(span);
    return result;
  }

  observed.then(
    (body: unknown) => {
      finish(span, shape, request, body);
    },
    (error: unknown) => {
      recordFailure(span, error);
      endSpan(span);
    },
  );
  return result;
}

function finish(span: Span, shape: LlmShape, request: LlmRequest, body: unknown): void {
  try {
    const response = shape.response(body, request);
    if (response) {
      span.setAttribute(GEN_AI_RESPONSE_MODEL, response.model);
      span.setAttribute(GEN_AI_COMPLETION, response.completion);
      span.setAttribute(GEN_AI_INPUT_TOKENS, response.inputTokens);
      span.setAttribute(GEN_AI_OUTPUT_TOKENS, response.outputTokens);
      if (response.finishReason) {
        span.setAttribute(GEN_AI_FINISH_REASONS, [response.finishReason]);
      }
    }
  } catch (error) {
    swallowed("reading an LLM response", error);
  }
  endSpan(span);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === "function";
}

/** Shared by both providers: a record-shaped value, or undefined. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** Shared by both providers: a non-negative integer, or 0 when absent. */
export function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
