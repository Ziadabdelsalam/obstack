import { SpanKind, type Attributes } from "@opentelemetry/api";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace";
import {
  GEN_AI_COMPLETION,
  GEN_AI_PROMPT,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_SYSTEM,
  llmSpanName,
} from "./attributes";
import { swallowed } from "./fail-open";

/**
 * The Vercel AI SDK leg. Nothing is patched here: `ai` already emits its own
 * OTel spans when a call passes `experimental_telemetry: { isEnabled: true }`,
 * so the work is translation, not instrumentation — this processor rewrites the
 * provider-call span in `onEnd`, which is before any exporter serialises it.
 *
 * What `ai` emits, measured on 5.0.237 and 6.0.256 (`vercel-ai.test.ts` pins
 * every literal below against the installed version, because a silent rename
 * upstream would cost the llm layer of the trace):
 *
 *   ai.generateText              — the outer call. No gen_ai.* attributes, so
 *                                  ingest classifies it `other`. Left alone.
 *   ai.generateText.doGenerate   — the provider call. Already carries
 *                                  gen_ai.request.model, gen_ai.response.model,
 *                                  gen_ai.usage.input_tokens/output_tokens and
 *                                  gen_ai.response.finish_reasons in exactly the
 *                                  D8 spelling.
 *
 * So three things are missing or wrong on that span, and three things are what
 * this processor changes:
 *
 *   gen_ai.system      — `ai` sets the qualified provider ("openai.chat");
 *                        D82 wants the bare vendor ("openai"). Overwritten.
 *   gen_ai.prompt      — absent; `ai.prompt.messages` is already the messages
 *                        array as a JSON string, which is what D82 asks for.
 *   gen_ai.completion  — absent; `ai.response.text` is the plain assistant text.
 *
 * The span is also renamed to `chat <model>` and its kind set to CLIENT (D82).
 * Both are plain fields on the SDK's Span, and both are set here rather than at
 * creation because the span is `ai`'s, not ours — there is no earlier hook.
 *
 * `ai` 7 is out of scope and out of the supported peer range: it stopped
 * emitting OTel spans altogether in favour of a `node:diagnostics_channel`
 * integration registry, so there is nothing on the wire for this to translate.
 */

/** Upstream's names. Theirs, not ours — hence not in `attributes.ts`. */
const AI_OPERATION_ID = "ai.operationId";
const AI_PROVIDER_CALL = "ai.generateText.doGenerate";
const AI_MODEL_PROVIDER = "ai.model.provider";
const AI_PROMPT_MESSAGES = "ai.prompt.messages";
const AI_RESPONSE_TEXT = "ai.response.text";

/** The fields of a Span that are readonly on ReadableSpan but plain properties
 *  on the SDK's implementation — which is what actually arrives in onEnd. */
interface MutableSpan {
  name: string;
  kind: SpanKind;
  attributes: Attributes;
}

/**
 * Registered by `init()`, ahead of the exporting processor. Harmless in an app
 * that does not use `ai`: without the marker attribute it never touches a span.
 */
export class VercelAiTranslationProcessor implements SpanProcessor {
  onStart(): void {}

  onEnd(span: ReadableSpan): void {
    try {
      translate(span);
    } catch (error) {
      swallowed("translating a Vercel AI SDK span", error);
    }
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

function translate(span: ReadableSpan): void {
  const attributes = span.attributes;
  if (attributes[AI_OPERATION_ID] !== AI_PROVIDER_CALL) return;

  const mutable = span as unknown as MutableSpan;

  const provider = attributes[AI_MODEL_PROVIDER];
  if (typeof provider === "string") mutable.attributes[GEN_AI_SYSTEM] = bareProvider(provider);

  const messages = attributes[AI_PROMPT_MESSAGES];
  if (typeof messages === "string") mutable.attributes[GEN_AI_PROMPT] = messages;

  const text = attributes[AI_RESPONSE_TEXT];
  if (typeof text === "string") mutable.attributes[GEN_AI_COMPLETION] = text;

  const model = attributes[GEN_AI_RESPONSE_MODEL] ?? attributes[GEN_AI_REQUEST_MODEL];
  if (typeof model === "string") mutable.name = llmSpanName(model);

  mutable.kind = SpanKind.CLIENT;
}

/** "openai.chat" -> "openai"; "anthropic" -> "anthropic" (D82). */
function bareProvider(provider: string): string {
  const dot = provider.indexOf(".");
  return dot === -1 ? provider : provider.slice(0, dot);
}
