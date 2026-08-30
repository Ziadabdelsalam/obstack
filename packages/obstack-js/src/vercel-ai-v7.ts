import { SpanKind, context, trace, type Span } from "@opentelemetry/api";
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
} from "./attributes";
import { endSpan, recordFailure, swallowed } from "./fail-open";
import { asCount, asRecord } from "./instrumentation/llm-span";
import { SDK_NAME, SDK_VERSION } from "./scope";
import { bareProvider } from "./vercel-ai";

/**
 * The Vercel AI SDK leg for `ai` 7, which is a different mechanism from the
 * `ai` 5/6 leg next door in `vercel-ai.ts` — not a wider version range on the
 * same one.
 *
 * `ai` 7 stopped emitting OpenTelemetry spans altogether: measured on 7.0.85
 * with a real tracer provider and an in-memory exporter, a `generateText` call
 * produces zero spans, with `telemetry: { isEnabled: true }` and with the
 * deprecated `experimental_telemetry` alias alike. There is nothing on the wire
 * for the v5/6 translation processor to rewrite, so the two legs never see the
 * same call: the processor keys on `ai.operationId`, which v7 never sets, and
 * this integration is only ever handed calls by v7's own dispatcher. That is why
 * both can be registered in one process — as `init()` does — with no double
 * emission. `vercel-ai-v7.test.ts` and `vercel-ai.test.ts` both assert exactly
 * one llm span per call, in one `npm test` run, with both paths live.
 *
 * What v7 offers instead is a public integration registry: an array on
 * `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS` that `registerTelemetry()` pushes
 * onto (`ai/src/telemetry/telemetry-registry.ts:6-11`) and the per-operation
 * dispatcher reads (`create-telemetry-dispatcher.ts:80-83`). obstack pushes onto
 * that array directly rather than importing `ai` to call `registerTelemetry`:
 * `ai` is an optional peer, so importing it would turn "the app happens to use
 * the Vercel AI SDK" into a hard dependency. Pushing before `ai` is loaded at
 * all still delivers every callback, because the array is read per operation and
 * not at import time — there is no init-ordering hazard on this door, unlike the
 * `require`-patching legs.
 *
 * There is a second door, a `node:diagnostics_channel` tracing channel, and it
 * is deliberately NOT subscribed (D304). It carries the same events plus `ai`'s
 * own internal nesting; obstack consumes none of that nesting, and the join that
 * matters — an llm span landing under a surrounding `traceAgent` span — comes
 * from `context.active()` at wrapper entry, which is the same AsyncLocalStorage
 * the channel would have ridden. One door, one span.
 *
 * ## Which hook owns the span
 *
 * `executeLanguageModelCall`, the context wrapper `ai` puts around the provider
 * call itself (`generate-text.ts:1020-1037`), and not the `onLanguageModelCallEnd`
 * callback. The callback looks like the natural place and is the wrong one: it
 * fires after `parseToolCall`, which can throw, and a span ended there leaks on
 * that path. The integration's `onError` is operation-level, not per model call,
 * so it cannot close the gap. The wrapper brackets the call exactly — it sees
 * the resolution and the rejection, and it is inside `ai`'s retry loop, so each
 * retry attempt is one span, which is correct: each attempt is a real call to a
 * real provider that a customer is really billed for.
 *
 * `onStart` exists here only to remember one thing the wrapper is not told: the
 * operation kind. Streaming stays out this release (D259) and the wrapper is
 * invoked for `doStream` too (`stream-language-model-call.ts:349`) with nothing
 * in its options to distinguish it, so the marker has to come from somewhere.
 * `onStart` carries `operationId` (`ai.generateText` / `ai.streamText`) and the
 * same `callId` the wrapper receives — measured identical on every version in
 * the supported range — so a `Map` keyed on `callId` carries it across, and
 * `onEnd`/`onError`/`onAbort` delete the entry. Upstream's own `@ai-sdk/otel`
 * integration keeps per-call state exactly this way
 * (`open-telemetry.ts:123-128,185-199,319`); that package is never a dependency
 * here (D302 — it declares `ai` as an exact hard dependency, so depending on it
 * would drag a pinned second copy of `ai` into every install, ai@5/6 apps
 * included).
 *
 * ## D92
 *
 * The content strip the v5/6 processor performs has no counterpart here and
 * needs none: v7 emits no spans, so there are no `ai.*` attributes anywhere for
 * prompt or completion content to survive in. Every attribute on a v7 llm span
 * is one this file set, and the only two carrying content are `gen_ai.prompt`
 * and `gen_ai.completion` — exactly the two ingest lifts into dedicated columns
 * and removes from the attributes map.
 */

/**
 * The `globalThis` key `ai` 7 reads its integrations from. Upstream's name, so
 * it does not belong in `attributes.ts` — that file is obstack's own contract
 * with ingest, not a place to keep other people's identifiers.
 *
 * Reached through a cast rather than a `declare global` block: `ai` declares
 * this same global in its own types, and a second declaration shipped in
 * obstack's `.d.ts` would collide in the type-check of any app that has both.
 */
const INTEGRATIONS_KEY = "AI_SDK_TELEMETRY_INTEGRATIONS";

/**
 * `onStart.operationId` for the streaming operations. A prefix rather than a
 * list because the marker is which FAMILY the operation belongs to, and a new
 * streaming entry point upstream should default to "no span", not to a span
 * with no tokens in it.
 *
 * In practice today only `ai.streamText` ever reaches the wrapper with this
 * prefix: `generateObject` and `streamObject` call the language model directly
 * rather than through `executeLanguageModelCall`, so neither draws an llm span
 * on this leg at all — measured, and symmetric with the v5/6 leg, which draws
 * none for `generateObject` either. So the `ai.streamObject` arm is unreachable
 * as upstream stands. It stays, because the value of a prefix test is exactly
 * that it is right about the entry point nobody has written yet.
 */
const STREAM_OPERATION_PREFIX = "ai.stream";

/**
 * The `callId` map's ceiling. Entries are released by `onEnd`/`onError`/
 * `onAbort` — but ONLY for an operation that actually terminates, and a stream
 * that the consumer abandons never does: for `streamText` the terminal hooks
 * are dispatched from inside the stream's own `TransformStream` flush/pull
 * (`stream-text.ts:1468,1571-1607`), so a stream nobody drains — a client that
 * disconnects mid-answer, which is routine — leaves its entry behind, and
 * `stream-object.ts:891` never dispatches `onAbort` at all. An unbounded map
 * keyed on that is a leak with a customer's traffic as the input.
 *
 * 1024 in-flight operations is far past any real concurrency for one process,
 * and the eviction is insertion-order (the oldest entry, which is the one least
 * likely to still be running). Evicting costs the evicted call its span, never
 * its result — see the wrapper's rule below.
 */
const MAX_TRACKED_OPERATIONS = 1024;

/**
 * The event fields obstack reads, declared structurally so this file compiles
 * with no `ai` import — an optional peer must not appear in the type graph of a
 * package that installs fine without it. Everything is optional and everything
 * is `unknown` except `callId`, which `ai` types as required on both events: a
 * shape that lies about what upstream sends is worse than a shape that checks.
 */
interface OperationStartEvent {
  readonly callId?: unknown;
  readonly operationId?: unknown;
}

/** The events whose only job here is to release the map entry. */
interface OperationEndEvent {
  readonly callId?: unknown;
}

/** What `ai` hands the `executeLanguageModelCall` wrapper. */
interface LanguageModelCallOptions<T> {
  readonly callId: string;
  readonly provider?: unknown;
  readonly modelId?: unknown;
  readonly instructions?: unknown;
  readonly messages?: unknown;
  readonly execute: () => PromiseLike<T>;
}

/**
 * The obstack integration. `ai` calls every method of this object from its own
 * dispatcher and awaits the callbacks, so no method may throw or be slow: a
 * telemetry integration that can fail an application's model call is the exact
 * thing D83 exists to prevent. Every body below is wrapped accordingly.
 *
 * The try/catch in `executeLanguageModelCall` is the load-bearing one. `ai`
 * error-isolates the notification hooks — `onStart`, `onEnd`, `onError`,
 * `onAbort` all go through `util/notify.ts` / `merge-callbacks.ts`, which
 * swallow what an integration throws — but the wrapper is awaited RAW
 * (`generate-text.ts:~1025`). An exception thrown out of it is an exception the
 * application sees instead of its answer. So the guards there are not belt and
 * braces; they are the only thing between a bug in this file and a broken model
 * call.
 */
export class ObstackVercelAiIntegration {
  /**
   * `callId` -> the operation's `operationId`, recorded in `onStart` because the
   * wrapper is not told which operation it belongs to. All three of
   * `onEnd`/`onError`/`onAbort` carry the `callId` and release the entry.
   *
   * What is NOT true — and was written here before it was measured — is that one
   * of them always fires. For the streaming operations they fire from inside the
   * stream's own machinery, so they fire only if the CONSUMER drains the stream:
   * `stream-text.ts:1468,1571-1607` dispatches from the `TransformStream`
   * flush/pull path, and `stream-object.ts:891` dispatches no `onAbort` at all.
   * An abandoned stream therefore leaves its entry here forever. That is why the
   * map is bounded (`MAX_TRACKED_OPERATIONS`) rather than merely tidy: bounded
   * state is the honest cost of hooks whose completion is conditional on
   * somebody else's behaviour.
   */
  private readonly operations = new Map<string, string>();

  onStart(event: OperationStartEvent): void {
    try {
      const { callId, operationId } = event ?? {};
      if (typeof callId === "string" && typeof operationId === "string") {
        // Insertion order is `Map`'s own iteration order, so the first key is the
        // oldest entry. Evicting it costs that operation its span and nothing
        // else; keeping every entry ever seen would cost the process its memory.
        if (this.operations.size >= MAX_TRACKED_OPERATIONS) {
          const oldest = this.operations.keys().next().value;
          if (oldest !== undefined) this.operations.delete(oldest);
        }
        this.operations.set(callId, operationId);
      }
    } catch (error) {
      swallowed("recording a Vercel AI SDK operation", error);
    }
  }

  onEnd(event: OperationEndEvent): void {
    this.release(event);
  }

  onError(event: OperationEndEvent): void {
    this.release(event);
  }

  onAbort(event: OperationEndEvent): void {
    this.release(event);
  }

  /**
   * The span. Returns the provider's own promise chained with the finalisation
   * — the caller here is `ai`'s dispatcher rather than the application, so
   * unlike the `openai`/`@anthropic-ai/sdk` patches there is no client-specific
   * promise subclass whose identity has to survive.
   */
  executeLanguageModelCall<T>(options: LanguageModelCallOptions<T>): PromiseLike<T> {
    const execute = options.execute;

    let started: { span: Span; requestModel: string } | undefined;
    try {
      started = this.start(options);
    } catch (error) {
      swallowed("starting a Vercel AI SDK v7 llm span", error);
    }
    // No span: a streaming call (D259), a call this SDK could not describe, or a
    // tracer that would not give us one. All three take the same exit — run the
    // model call exactly as `ai` would have run it unwrapped.
    if (!started) return execute();

    const { span, requestModel } = started;

    let result: PromiseLike<T>;
    try {
      // The provider call runs inside the span's context so that the HTTP span
      // instrumentation-http draws for the real request nests under the llm
      // span rather than beside it.
      result = context.with(trace.setSpan(context.active(), span), execute);
    } catch (error) {
      // `execute` is declared async upstream, so this is the shape that should
      // never happen — recorded rather than assumed away.
      recordFailure(span, error);
      endSpan(span);
      throw error;
    }

    return result.then(
      (value: T) => {
        finish(span, requestModel, value);
        return value;
      },
      (error: unknown) => {
        // The application's exception is evidence, never ours to swallow: it is
        // recorded on the span and re-thrown exactly as `ai` threw it.
        recordFailure(span, error);
        endSpan(span);
        throw error;
      },
    );
  }

  private release(event: OperationEndEvent): void {
    try {
      const callId = event?.callId;
      if (typeof callId === "string") this.operations.delete(callId);
    } catch (error) {
      swallowed("releasing a Vercel AI SDK operation", error);
    }
  }

  private start<T>(
    options: LanguageModelCallOptions<T>,
  ): { span: Span; requestModel: string } | undefined {
    // The rule, D314, in one sentence: a span only when the `callId` entry
    // EXISTS and its `operationId` does not start with `ai.stream`. A missing or
    // evicted entry takes the same exit as a streaming one — the call runs
    // exactly as `ai` would have run it unwrapped.
    //
    // Missing is the safe default rather than the cautious one. Without the
    // entry this code cannot tell a `generateText` from a `streamText`, and
    // guessing "not streaming" would put a zero-token llm span on the wire for a
    // stream, which ingest prices at $0. A missing span is an honest gap; a
    // wrong cost is not.
    const operationId = this.operations.get(options.callId);
    if (typeof operationId !== "string") return undefined;
    if (operationId.startsWith(STREAM_OPERATION_PREFIX)) return undefined;

    // Without a model there is no `gen_ai.request.model`, no span name and no
    // cost — the span would land in ClickHouse classified as llm and carry none
    // of what makes an llm span worth having. `ai` requires `modelId` on every
    // language model, so this is a guard, not a supported path.
    const requestModel = options.modelId;
    if (typeof requestModel !== "string" || requestModel.length === 0) return undefined;

    const attributes: Record<string, string> = {
      [GEN_AI_REQUEST_MODEL]: requestModel,
      [GEN_AI_PROMPT]: promptJson(options.instructions, options.messages),
    };
    // `ai` reports the qualified provider ("openai.chat"); D82 wants the bare
    // vendor, because that is what ingest's price list and the UI's provider
    // column key on. The same function the v5/6 translation uses, imported
    // rather than copied — one rule, one implementation.
    const provider = options.provider;
    if (typeof provider === "string") attributes[GEN_AI_SYSTEM] = bareProvider(provider);

    const span = trace
      .getTracer(SDK_NAME, SDK_VERSION)
      .startSpan(
        llmSpanName(requestModel),
        { kind: SpanKind.CLIENT, attributes },
        // The join to a surrounding `traceAgent` span. `ai`'s dispatcher runs
        // this wrapper inside the caller's async context, so the active context
        // here is the application's — proven red-then-green in the test suite,
        // because a parent that is silently ROOT still produces a span and
        // still passes every attribute assertion.
        context.active(),
      );

    return { span, requestModel };
  }
}

/**
 * Pushes one obstack integration onto `ai` 7's registry. Called by `init()`,
 * which is itself idempotent; the module-level guard covers the case where an
 * app has somehow loaded two copies of this module.
 */
export function registerVercelAiV7Integration(): void {
  if (registered) return;
  const holder = globalThis as unknown as Record<string, unknown>;
  const existing = holder[INTEGRATIONS_KEY];
  const integrations = Array.isArray(existing) ? (existing as unknown[]) : [];
  if (!Array.isArray(existing)) holder[INTEGRATIONS_KEY] = integrations;
  integrations.push(new ObstackVercelAiIntegration());
  registered = true;
}

let registered = false;

/**
 * `gen_ai.prompt`, per D82's wire form and D300's one rule for both the v7 and
 * the Responses paths: a JSON array of messages in verbatim order, with the
 * system text as the LEADING element when it arrives outside the array.
 *
 * v7 relocated it. `generateText({ system, prompt })` delivers the system text
 * as `event.instructions`, a sibling of `event.messages` rather than
 * `messages[0]`, so `JSON.stringify(event.messages)` alone would silently drop
 * the system prompt from the captured content. Folding it back in as
 * `{role:"system", content}` is not a synthesised envelope: it is the form
 * `ai` 5/6 already put on the wire (pinned in `vercel-ai.test.ts`) and the form
 * the `openai` chat patch carries, so the same conversation serialises the same
 * way on all three paths.
 *
 * The messages themselves are serialised untouched. They are not byte-identical
 * to `ai` 6's — v7 hands over the standardised prompt, where a text-only user
 * turn's `content` is the bare string, while v6's `ai.prompt.messages` carried
 * the converted provider prompt, where the same turn's `content` is
 * `[{type:"text",text:…}]`. That is `ai`'s own normalisation moving, not a
 * decision here; `vercel-ai-v7.test.ts` pins both forms side by side.
 */
function promptJson(instructions: unknown, messages: unknown): string {
  const parts: unknown[] = [];
  if (typeof instructions === "string" && instructions.length > 0) {
    parts.push({ role: "system", content: instructions });
  }
  if (Array.isArray(messages)) parts.push(...messages);
  return JSON.stringify(parts);
}

/**
 * The D8 response half. The value handed back here is the provider's raw
 * `LanguageModelV4` result — `ai` normalises it afterwards, so `response.modelId`
 * is whatever the provider actually set and falls back to the requested model,
 * which is what `ai` itself does one line later (`generate-text.ts:1042`).
 */
function finish(span: Span, requestModel: string, result: unknown): void {
  try {
    const body = asRecord(result);
    const response = asRecord(body?.["response"]);
    const responseModel = response?.["modelId"];
    span.setAttribute(
      GEN_AI_RESPONSE_MODEL,
      typeof responseModel === "string" ? responseModel : requestModel,
    );

    span.setAttribute(GEN_AI_COMPLETION, completionText(body?.["content"]));

    // v7's token counts are nested one level deeper than v5/6's flat ints:
    // `usage.inputTokens` is an object whose `total` is the number D8 wants, with
    // the cache and reasoning breakdowns beside it. Those breakdowns have no D8
    // name and are not given one here (D81).
    const usage = asRecord(body?.["usage"]);
    span.setAttribute(GEN_AI_INPUT_TOKENS, tokenTotal(usage?.["inputTokens"]));
    span.setAttribute(GEN_AI_OUTPUT_TOKENS, tokenTotal(usage?.["outputTokens"]));

    // Likewise the finish reason: v7 reports `{unified, raw}` where v5/6
    // reported the scalar. `unified` is the cross-provider spelling and the one
    // that matches what v6 put on the wire ("stop", "tool-calls", "length").
    const finishReason = asRecord(body?.["finishReason"]);
    const unified = finishReason?.["unified"];
    if (typeof unified === "string" && unified.length > 0) {
      span.setAttribute(GEN_AI_FINISH_REASONS, [unified]);
    }
  } catch (error) {
    swallowed("reading a Vercel AI SDK v7 response", error);
  }
  endSpan(span);
}

/** The assistant's reply as the plain text a person reads: every `text` part of
 *  the result content, concatenated — the same reduction `ai` performs for its
 *  own `result.text` (`generate-text/extract-text-content.ts`). */
function completionText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const entry of content) {
    const part = asRecord(entry);
    if (part?.["type"] === "text" && typeof part["text"] === "string") texts.push(part["text"]);
  }
  return texts.join("");
}

/** `usage.inputTokens.total` / `usage.outputTokens.total`, or 0 — the same
 *  posture the `openai` and `@anthropic-ai/sdk` paths take on a missing count. */
function tokenTotal(bucket: unknown): number {
  return asCount(asRecord(bucket)?.["total"]);
}
