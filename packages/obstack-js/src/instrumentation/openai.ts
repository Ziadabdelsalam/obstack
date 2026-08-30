import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
} from "@opentelemetry/instrumentation";
import { SYSTEM_OPENAI } from "../attributes";
import { swallowed } from "../fail-open";
import { SDK_NAME, SDK_VERSION } from "../scope";
import { asCount, asRecord, traceLlmCall, type LlmRequest, type LlmResponse, type LlmShape } from "./llm-span";

/**
 * Auto-instrumentation for `openai`'s chat-completions call, written here
 * rather than taken from otel-contrib (D77(a)): the upstream GenAI
 * instrumentations emit prompts and completions as span EVENTS, which ingest
 * deliberately does not read (D38 FINAL), so their spans would land in
 * ClickHouse with no content at all. This one emits the D8 span-attribute form
 * by construction.
 *
 * The patch target is the module the client actually uses at runtime, not the
 * re-export beside it: `Completions.prototype.create` from
 * `openai/resources/chat/completions/completions.js` is the prototype of
 * `client.chat.completions` on 4.85.4, 5.23.2, 6.49.0 and 7.4.0 (checked, not
 * assumed — that is what the supported range below is based on).
 *
 * The floor is 4.85, not 4: that module does not exist below it — openai kept
 * chat completions in a flat `resources/chat/completions.js` through 4.84.1, so
 * the file matcher never fires and the call goes out with no span and no error.
 * A wider range would advertise coverage that is silently absent.
 */
const OPENAI_VERSIONS = [">=4.85 <8"];
const COMPLETIONS_MODULE = "openai/resources/chat/completions/completions.js";

/**
 * The Responses API is a second module file under the same package definition,
 * with its own floor: `openai/resources/responses/responses.js` does not exist
 * on 4.85.4, 4.86.0 or 4.86.2 (measured — `client.responses` is `undefined`
 * there), and appears with class `Responses` and prototype `create` from 4.87.0
 * through 7.8.0. Below 4.87 the file matcher simply never fires, which is the
 * same honest absence the chat floor has below 4.85: the call goes out, no span
 * is drawn, nothing throws. The package range stays `>=4.85 <8` because chat
 * coverage on 4.85–4.86 is real.
 *
 * The target is again the prototype the client dispatches through, checked and
 * not assumed: `Object.getPrototypeOf(client.responses).create ===
 * Responses.prototype.create` on every version in the range. `parse()` and
 * `stream()` both route back through this same `create` (`responses.js` calls
 * `this._client.responses.create(...)`, and `ResponseStream.createResponse`
 * calls it with `stream: true`), so `parse()` is covered here for free with no
 * double count and `stream()` is refused by the one `body.stream` guard below.
 * The neighbours that do NOT dispatch through it are out of scope by
 * construction: `resources/beta/responses/responses.js` is a different class,
 * and `compact()` / `retrieve()` build a `Response` without `create`.
 */
const RESPONSES_VERSIONS = [">=4.87 <8"];
const RESPONSES_MODULE = "openai/resources/responses/responses.js";

export class OpenAIInstrumentation extends InstrumentationBase {
  constructor() {
    super(`${SDK_NAME}/openai`, SDK_VERSION, {});
  }

  protected init(): InstrumentationNodeModuleDefinition {
    const completions = new InstrumentationNodeModuleFile(
      COMPLETIONS_MODULE,
      OPENAI_VERSIONS,
      (moduleExports: { Completions?: { prototype: Record<string, unknown> } }) => {
        const prototype = moduleExports?.Completions?.prototype;
        if (!prototype) {
          // Upstream moved the class. Say so and leave the app alone (D83).
          swallowed(`patching ${COMPLETIONS_MODULE}`, new Error("no Completions.prototype export"));
          return moduleExports;
        }
        if (isWrapped(prototype.create)) this._unwrap(prototype, "create");
        this._wrap(prototype, "create", this.patchCreate(OPENAI_SHAPE));
        return moduleExports;
      },
      (moduleExports: { Completions?: { prototype: Record<string, unknown> } } | undefined) => {
        const prototype = moduleExports?.Completions?.prototype;
        if (prototype && isWrapped(prototype.create)) this._unwrap(prototype, "create");
      },
    );

    const responses = new InstrumentationNodeModuleFile(
      RESPONSES_MODULE,
      RESPONSES_VERSIONS,
      (moduleExports: { Responses?: { prototype: Record<string, unknown> } }) => {
        const prototype = moduleExports?.Responses?.prototype;
        if (!prototype) {
          // Upstream moved the class. Say so and leave the app alone (D83).
          swallowed(`patching ${RESPONSES_MODULE}`, new Error("no Responses.prototype export"));
          return moduleExports;
        }
        if (isWrapped(prototype.create)) this._unwrap(prototype, "create");
        this._wrap(prototype, "create", this.patchCreate(RESPONSES_SHAPE, shareOneParse));
        return moduleExports;
      },
      (moduleExports: { Responses?: { prototype: Record<string, unknown> } } | undefined) => {
        const prototype = moduleExports?.Responses?.prototype;
        if (prototype && isWrapped(prototype.create)) this._unwrap(prototype, "create");
      },
    );

    return new InstrumentationNodeModuleDefinition(
      "openai",
      OPENAI_VERSIONS,
      undefined,
      undefined,
      [completions, responses],
    );
  }

  private patchCreate(shape: LlmShape, adapt: (create: Create) => Create = (create) => create) {
    const instrumentation = this;
    return (original: unknown) => {
      const create = adapt(original as Create);
      return function patchedCreate(this: unknown, ...args: unknown[]): unknown {
        return traceLlmCall(instrumentation.tracer, shape, create, this, args);
      };
    };
  }
}

type Create = (...args: unknown[]) => unknown;

/**
 * The one thing the Responses patch needs that the chat patch does not, and the
 * reason it is here rather than in `llm-span.ts`: it is an `openai` quirk, not a
 * fact about LLM spans.
 *
 * An HTTP body can be read exactly once. `APIPromise` knows that and memoises
 * its parse — but `_thenUnwrap()`, which derives a new APIPromise from an
 * existing one, calls the parent's `parseResponse` **directly**, bypassing that
 * memo (`core/api-promise.js` on 5.x–7.x, `core.js` on 4.87.x — identical in
 * both). Every read after the first then throws `TypeError: Body is unusable`.
 *
 * `responses.create()` returns such a derived promise (it unwraps to attach
 * `output_text`), and `responses.parse()` derives a second one from THAT. With
 * no instrumentation there is still only one consumer, so nothing breaks. But
 * this instrumentation observes the promise `create()` returned — that is one
 * read — and `parse()`'s own unwrap is then the second: **measured, an
 * uninstrumented `responses.parse()` succeeds and an instrumented one throws.**
 * Telemetry that breaks the call it is watching is the one outcome fail-open
 * exists to prevent (D83), and no span is worth it.
 *
 * So the parse is memoised on the promise before anything observes it, and the
 * two consumers share one read of the body — the same thing `APIPromise.parse()`
 * already does for its own callers. `chat.completions.create` needs none of
 * this: it returns the base promise, with nothing derived from it.
 */
function shareOneParse(create: Create): Create {
  return function sharedParse(this: unknown, ...args: unknown[]): unknown {
    const promise = create.apply(this, args);
    try {
      const target = promise as { parseResponse?: unknown };
      const parseResponse = target?.parseResponse;
      if (typeof parseResponse !== "function") return promise;
      let parsed: unknown;
      let read = false;
      target.parseResponse = (...props: unknown[]): unknown => {
        if (!read) {
          read = true;
          parsed = (parseResponse as Create).apply(promise, props);
        }
        return parsed;
      };
    } catch (error) {
      // A frozen promise, or a version that keeps the parse somewhere else.
      // The call itself is unaffected; say so and let it through (D83).
      swallowed("sharing one parse of an openai response", error);
    }
    return promise;
  };
}

/**
 * `create(body, options?)`, where body is a ChatCompletionCreateParams and the
 * resolved value is a ChatCompletion.
 */
const OPENAI_SHAPE: LlmShape = {
  request(args: readonly unknown[]): LlmRequest | undefined {
    const body = asRecord(args[0]);
    if (!body) return undefined;
    // Streaming passes through uninstrumented this sprint (D77(e)): the tokens
    // arrive in the stream, and a span that reported zero of them would be
    // priced at $0 by ingest — a wrong number is worse than a missing span.
    if (body.stream === true) return undefined;
    const model = body.model;
    if (typeof model !== "string") return undefined;
    return {
      system: SYSTEM_OPENAI,
      model,
      prompt: JSON.stringify(body.messages ?? []),
    };
  },

  response(value: unknown, request: LlmRequest): LlmResponse | undefined {
    const body = asRecord(value);
    if (!body) return undefined;
    const choice = asRecord(Array.isArray(body.choices) ? body.choices[0] : undefined);
    const message = asRecord(choice?.message);
    const usage = asRecord(body.usage);
    return {
      model: typeof body.model === "string" ? body.model : request.model,
      completion: typeof message?.content === "string" ? message.content : "",
      inputTokens: asCount(usage?.prompt_tokens),
      outputTokens: asCount(usage?.completion_tokens),
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : "",
    };
  },
};

/**
 * `responses.create(body, options?)`, where body is a ResponseCreateParams and
 * the resolved value is a Response. Same D8 emission as the chat shape above,
 * over a different set of field names — which is the whole reason `LlmShape`
 * exists: nothing in `llm-span.ts` changes to carry this API.
 *
 * The span name stays `chat <model>`. There is no `responses` value in the
 * semantic conventions' `gen_ai.operation.name` enum to name it with, ingest
 * classifies the llm layer by the presence of any `gen_ai.*` attribute rather
 * than by span name, and a second name would split one concept in the UI.
 *
 * `cached_tokens` and `reasoning_tokens` are read by nobody and named nowhere
 * in `attributes.ts`, so they are not emitted (D81): an attribute this SDK
 * invents is an attribute ingest drops.
 */
const RESPONSES_SHAPE: LlmShape = {
  request(args: readonly unknown[]): LlmRequest | undefined {
    const body = asRecord(args[0]);
    if (!body) return undefined;
    // One guard covers both entry points: `create({stream: true})` and
    // `responses.stream()`, which reaches this same function with `stream`
    // already set. Streaming stays uninstrumented for the reason the chat path
    // gives — the tokens arrive in the stream, and a $0 span is a wrong number.
    if (body.stream === true) return undefined;
    const model = body.model;
    // `model` is optional in the 7.x types (a stored `prompt: { id }` can carry
    // it instead). Without one there is no `gen_ai.request.model` and no span
    // name, so the call runs uninstrumented rather than half-described — the
    // same exit the chat shape and the `ai` 7 leg take.
    if (typeof model !== "string") return undefined;
    return {
      system: SYSTEM_OPENAI,
      model,
      prompt: responsesPrompt(body.instructions, body.input),
    };
  },

  response(value: unknown, request: LlmRequest): LlmResponse | undefined {
    const body = asRecord(value);
    if (!body) return undefined;
    const usage = asRecord(body.usage);
    return {
      model: typeof body.model === "string" ? body.model : request.model,
      // `output_text` is a convenience the CLIENT adds, not a wire field: the
      // SDK only decorates the object when the payload says `object:"response"`
      // (`lib/ResponsesParser.js`), so trusting it alone would silently lose
      // the completion on any response that omits it. It is used when present
      // and recomputed from `output[]` when it is not.
      completion: typeof body.output_text === "string" ? body.output_text : outputText(body.output),
      inputTokens: asCount(usage?.input_tokens),
      outputTokens: asCount(usage?.output_tokens),
      // The Responses API has no `finish_reason` anywhere in its schema. The
      // one provider-native field that says how the turn ended is `status`
      // (`completed`, `incomplete`, `failed`, …), so that is what is recorded,
      // verbatim and unmapped (D82/D301). Folding `incomplete_details.reason`
      // in when the status is `incomplete` would read more like the chat path's
      // `length`, but it is a composite this SDK would be inventing.
      finishReason: typeof body.status === "string" ? body.status : "",
    };
  },
};

/**
 * `gen_ai.prompt` for the Responses API, in the one wire form D300 fixes for
 * every path: a JSON array of messages in verbatim order, with system text
 * folded in as the LEADING element when it arrives beside the messages rather
 * than inside them.
 *
 * Responses relocated both halves. The system prompt is `instructions`, a
 * sibling of `input`, so serialising `input` alone would silently drop it; and
 * `input` may be a bare string, which the API itself defines as the equivalent
 * of a single user message. Array elements are passed through untouched.
 */
function responsesPrompt(instructions: unknown, input: unknown): string {
  const parts: unknown[] = [];
  if (typeof instructions === "string" && instructions.length > 0) {
    parts.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") parts.push({ role: "user", content: input });
  else if (Array.isArray(input)) parts.push(...input);
  return JSON.stringify(parts);
}

/**
 * The assistant's reply as plain text, recovered from `output[]` the way the
 * client's own `addOutputText` does it: message items only, their `output_text`
 * content joined with nothing between. A turn that produced only tool calls or
 * reasoning has no text, and `""` is the honest answer — the same one the chat
 * shape gives for a tool-call-only choice.
 */
function outputText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  const texts: string[] = [];
  for (const item of output) {
    const message = asRecord(item);
    if (message?.type !== "message" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const chunk = asRecord(part);
      if (chunk?.type === "output_text" && typeof chunk.text === "string") texts.push(chunk.text);
    }
  }
  return texts.join("");
}
