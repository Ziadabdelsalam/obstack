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
        this._wrap(prototype, "create", this.patchCreate());
        return moduleExports;
      },
      (moduleExports: { Completions?: { prototype: Record<string, unknown> } } | undefined) => {
        const prototype = moduleExports?.Completions?.prototype;
        if (prototype && isWrapped(prototype.create)) this._unwrap(prototype, "create");
      },
    );

    return new InstrumentationNodeModuleDefinition(
      "openai",
      OPENAI_VERSIONS,
      undefined,
      undefined,
      [completions],
    );
  }

  private patchCreate() {
    const instrumentation = this;
    return (original: unknown) =>
      function patchedCreate(this: unknown, ...args: unknown[]): unknown {
        return traceLlmCall(
          instrumentation.tracer,
          OPENAI_SHAPE,
          original as (...a: unknown[]) => unknown,
          this,
          args,
        );
      };
  }
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
