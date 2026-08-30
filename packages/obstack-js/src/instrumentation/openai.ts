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
        this._wrap(prototype, "create", this.patchCreate(RESPONSES_SHAPE, observeResponsesBody));
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

  private patchCreate(shape: LlmShape, observe?: Observe) {
    const instrumentation = this;
    return (original: unknown) => {
      const create = original as Create;
      return function patchedCreate(this: unknown, ...args: unknown[]): unknown {
        return traceLlmCall(instrumentation.tracer, shape, create, this, args, observe);
      };
    };
  }
}

type Create = (...args: unknown[]) => unknown;

/**
 * How the Responses span gets the response body, and the one thing this patch
 * needs that the chat patch does not: it is an `openai` quirk, not a fact about
 * LLM spans, so it lives here rather than in `llm-span.ts`.
 *
 * An HTTP body can be read exactly once. `chat.completions.create` hands back
 * the base `APIPromise`, which memoises its own parse, so simply watching that
 * promise costs nothing. `responses.create` does not: it returns a promise
 * DERIVED from the base one (`_thenUnwrap`, to attach `output_text`), and
 * `responses.parse()` derives a second from that. Every derivation re-parses
 * the same raw `Response`, so whoever reads first wins and every later read
 * throws `TypeError: Body is unusable: Body has already been read`.
 *
 * Two approaches were measured and both are wrong:
 *
 * - **Watching the returned promise** (`p.then(...)`, what every other patch
 *   here does) makes the instrumentation the FIRST reader. Uninstrumented,
 *   `responses.parse()` succeeds; instrumented that way it throws — measured on
 *   4.87.0 and 7.8.0. Telemetry that breaks the call it is watching is the one
 *   outcome fail-open exists to prevent (D83), and no span is worth it.
 *
 * - **Memoising `parseResponse` on the promise** works on 4.87.0 and 7.4.0 and
 *   is a silent no-op from 7.5.0: `client.js:508` (`client.ts:989` in the
 *   sources) installs a PER-INSTANCE `_thenUnwrap` that closes over the
 *   module-local `parse` and never calls `this.parseResponse`, so the memo is
 *   simply not on the path any more. Same throw, inside the advertised peer
 *   range, invisible to a suite pinned below 7.5.
 *
 * So the observer never reads the original body at all. `APIPromise` keeps the
 * in-flight request on a public field named `responsePromise` — measured on
 * 4.87.0 (`core.js:77`), 7.4.0 and 7.8.0 (`core/api-promise.js`, the
 * constructor; on 7.5+ `client.responsePromise()` builds the same object) — and
 * that promise resolves to `{ response, ... }` WITHOUT reading the body;
 * `defaultParseResponse` is what calls `response.text()`, later. Registering
 * here, synchronously, before the promise is handed back to the application,
 * makes obstack the first REACTION on it and `response.clone()` the first thing
 * that happens to it. Cloning a `Response` before its body is read is ordinary
 * fetch semantics — it tees the stream — so the application's own derivations
 * then read the original exactly once, exactly as they do uninstrumented.
 *
 * The cost of the clone is a tee of one response body, paid only on a
 * non-streaming Responses call that this SDK is drawing a span for — streaming
 * requests never reach here, because the shape declines them before the call is
 * made.
 *
 * Every exit below is the fail-open one: no `responsePromise` to watch, or a
 * `Response` that cannot be cloned, or a body that is not JSON, and the span
 * simply ends without its response half. The application's promise is returned
 * untouched in every case and nothing here can throw into it — this function's
 * result is fully handled by `traceLlmCall`, so a rejection lands on the span's
 * error path and never as an unhandled rejection in the app.
 */
type Observe = (result: unknown) => PromiseLike<unknown> | undefined;

function observeResponsesBody(result: unknown): PromiseLike<unknown> | undefined {
  const inFlight = (result as { responsePromise?: unknown } | undefined)?.responsePromise;
  if (typeof (inFlight as PromiseLike<unknown> | undefined)?.then !== "function") {
    // A version that keeps the raw response somewhere else. Say so once and
    // leave the call completely alone (D83).
    swallowed(
      "observing an openai Responses call",
      new Error("the APIPromise has no responsePromise to watch"),
    );
    return undefined;
  }

  return (inFlight as PromiseLike<{ response?: { clone?: unknown } }>).then((props) => {
    const response = props?.response;
    if (typeof response?.clone !== "function") {
      swallowed(
        "observing an openai Responses call",
        new Error("the raw Response cannot be cloned"),
      );
      return undefined;
    }
    // The clone is taken here, in the first reaction on `responsePromise`,
    // before anything has read the original.
    return (response.clone as () => { json(): Promise<unknown> })()
      .json()
      .catch((error: unknown) => {
        // A 204, an empty body, a non-JSON error page. The application's call is
        // unaffected; the span ends with its request half and no completion.
        swallowed("reading an openai Responses body", error);
        return undefined;
      });
  });
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
