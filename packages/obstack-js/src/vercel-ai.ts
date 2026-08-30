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
 * The Vercel AI SDK leg for `ai` 5 and 6. There are two Vercel-AI paths in this
 * package and this is the older one: `ai` 5/6 emits OTel spans that get
 * translated here, while `ai` 7 emits none and is instrumented through its
 * integration registry in `vercel-ai-v7.ts`. Both are registered by `init()`,
 * and they never both fire for one call — the processor below keys on
 * `ai.operationId`, which `ai` 7 never sets.
 *
 * Nothing is patched here: `ai` already emits its own OTel spans when a call
 * passes `experimental_telemetry: { isEnabled: true }`, so the work is
 * translation, not instrumentation — this processor rewrites the provider-call
 * span in `onEnd`, which is before any exporter serialises it.
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
 * And the fourth thing, which is why this is a translation rather than a copy
 * (D92): the upstream content attributes are DELETED. `gen_ai.prompt` and
 * `gen_ai.completion` are lifted into dedicated columns by ingest and removed
 * from the attributes Map (D8-AMENDMENT), but ingest strips exactly those two
 * names and never guesses at foreign ones — for a bring-your-own-OTel producer
 * the Map copy is the customer's only copy, and an ingest-side blacklist would
 * destroy data obstack does not own. So the perimeter is here: obstack's own
 * SDKs must not ship prompt or completion content into the Map under ANY key.
 * Leaving `ai.prompt.messages` behind would have put the whole conversation in
 * the Map next to a column that exists precisely to keep it out.
 *
 * The strip runs on EVERY span carrying `ai.operationId`, not only the one
 * translated: the outer `ai.generateText` span gets no `gen_ai.*` attributes and
 * still classifies `other`, but it carries the full input under `ai.prompt`.
 *
 * `ai` 7 is out of scope for THIS processor and stays that way: it stopped
 * emitting OTel spans altogether in favour of a public integration registry, so
 * there is nothing on the wire for this to translate. That version is covered —
 * see `vercel-ai-v7.ts`, which owns the whole v7 path and shares `bareProvider`
 * with this file so the two agree on what a provider is called.
 */

/** Upstream's names. Theirs, not ours — hence not in `attributes.ts`. */
const AI_OPERATION_ID = "ai.operationId";
const AI_PROVIDER_CALL = "ai.generateText.doGenerate";
const AI_MODEL_PROVIDER = "ai.model.provider";
const AI_PROMPT = "ai.prompt";
const AI_PROMPT_MESSAGES = "ai.prompt.messages";
const AI_RESPONSE_TEXT = "ai.response.text";

/**
 * Every upstream attribute that can carry the user's input or the model's
 * output. Deleted from any `ai` span, after the mapping above has read what it
 * needs from them.
 *
 * Measured against the pinned `ai` 6.0.256: of the 15 distinct `ai.*` attributes
 * a `generateText` call emits across its two spans, exactly three are
 * content-bearing — `ai.prompt` (outer), `ai.prompt.messages` (provider call)
 * and `ai.response.text` (both). The other twelve are metadata (`ai.model.*`,
 * `ai.operationId`, `ai.request.headers.*`, `ai.response.finishReason`/`id`/
 * `model`/`timestamp`, `ai.settings.*`, `ai.usage.*`) and are kept —
 * `vercel-ai.test.ts` records that enumeration and goes red on an `ai.*`
 * attribute it has not classified.
 *
 * The list is wider than those three on purpose. Tool calls and structured
 * output travel the same pipeline and put arguments, results and generated
 * objects in the Map; this fixture exercises neither, so those keys are unproven
 * rather than absent. Deleting a key that is not there costs nothing, and the
 * failure it prevents is a customer's tool arguments landing in a column-less
 * Map forever.
 */
const AI_CONTENT_ATTRIBUTES = [
  AI_PROMPT,
  AI_PROMPT_MESSAGES,
  "ai.prompt.tools",
  "ai.prompt.toolChoice",
  AI_RESPONSE_TEXT,
  "ai.response.object",
  "ai.response.toolCalls",
  "ai.toolCall.args",
  "ai.toolCall.result",
] as const;

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
  // Any span the Vercel AI SDK made. The mapping below applies to the provider
  // call alone; the content strip at the end applies to all of them.
  if (attributes[AI_OPERATION_ID] === undefined) return;

  const mutable = span as unknown as MutableSpan;

  if (attributes[AI_OPERATION_ID] === AI_PROVIDER_CALL) {
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

  // Last, and only here: the block above reads these very attributes, so
  // deleting earlier would translate the content into nothing (D92).
  for (const key of AI_CONTENT_ATTRIBUTES) delete mutable.attributes[key];
}

/** "openai.chat" -> "openai"; "anthropic" -> "anthropic" (D82). Exported for
 *  `vercel-ai-v7.ts`: `ai` 7 reports the provider in exactly the same
 *  qualified form, and two copies of this rule would be two chances to
 *  disagree about a value ingest prices on. */
export function bareProvider(provider: string): string {
  const dot = provider.indexOf(".");
  return dot === -1 ? provider : provider.slice(0, dot);
}
