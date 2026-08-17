import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
} from "@opentelemetry/instrumentation";
import { SYSTEM_ANTHROPIC } from "../attributes";
import { swallowed } from "../fail-open";
import { SDK_NAME, SDK_VERSION } from "../scope";
import { asCount, asRecord, traceLlmCall, type LlmRequest, type LlmResponse, type LlmShape } from "./llm-span";

/**
 * Auto-instrumentation for `@anthropic-ai/sdk`'s messages call — the same shape
 * as the OpenAI one, and here for the same reason (D77(a)).
 *
 * `Messages.prototype.create` from `@anthropic-ai/sdk/resources/messages/
 * messages.js` is the prototype of `client.messages` on 0.50.4, 0.70.1,
 * 0.100.1 and 0.117.1 (checked). 0.30.1 has no such path, which is where the
 * lower bound of the supported range comes from.
 */
const ANTHROPIC_VERSIONS = [">=0.50 <1"];
const MESSAGES_MODULE = "@anthropic-ai/sdk/resources/messages/messages.js";

export class AnthropicInstrumentation extends InstrumentationBase {
  constructor() {
    super(`${SDK_NAME}/anthropic`, SDK_VERSION, {});
  }

  protected init(): InstrumentationNodeModuleDefinition {
    const messages = new InstrumentationNodeModuleFile(
      MESSAGES_MODULE,
      ANTHROPIC_VERSIONS,
      (moduleExports: { Messages?: { prototype: Record<string, unknown> } }) => {
        const prototype = moduleExports?.Messages?.prototype;
        if (!prototype) {
          swallowed(`patching ${MESSAGES_MODULE}`, new Error("no Messages.prototype export"));
          return moduleExports;
        }
        if (isWrapped(prototype.create)) this._unwrap(prototype, "create");
        this._wrap(prototype, "create", this.patchCreate());
        return moduleExports;
      },
      (moduleExports: { Messages?: { prototype: Record<string, unknown> } } | undefined) => {
        const prototype = moduleExports?.Messages?.prototype;
        if (prototype && isWrapped(prototype.create)) this._unwrap(prototype, "create");
      },
    );

    return new InstrumentationNodeModuleDefinition(
      "@anthropic-ai/sdk",
      ANTHROPIC_VERSIONS,
      undefined,
      undefined,
      [messages],
    );
  }

  private patchCreate() {
    const instrumentation = this;
    return (original: unknown) =>
      function patchedCreate(this: unknown, ...args: unknown[]): unknown {
        return traceLlmCall(
          instrumentation.tracer,
          ANTHROPIC_SHAPE,
          original as (...a: unknown[]) => unknown,
          this,
          args,
        );
      };
  }
}

/**
 * `create(body, options?)`, where body is a MessageCreateParams and the
 * resolved value is a Message.
 */
const ANTHROPIC_SHAPE: LlmShape = {
  request(args: readonly unknown[]): LlmRequest | undefined {
    const body = asRecord(args[0]);
    if (!body) return undefined;
    if (body.stream === true) return undefined; // as in openai.ts: not this sprint
    const model = body.model;
    if (typeof model !== "string") return undefined;
    return {
      system: SYSTEM_ANTHROPIC,
      model,
      // The messages array verbatim (D82). Anthropic carries the system prompt
      // in a sibling field rather than as a message; folding it in would be
      // this SDK inventing a message the caller never sent.
      prompt: JSON.stringify(body.messages ?? []),
    };
  },

  response(value: unknown, request: LlmRequest): LlmResponse | undefined {
    const body = asRecord(value);
    if (!body) return undefined;
    const usage = asRecord(body.usage);
    return {
      model: typeof body.model === "string" ? body.model : request.model,
      completion: textOf(body.content),
      inputTokens: asCount(usage?.input_tokens),
      outputTokens: asCount(usage?.output_tokens),
      // stop_reason passed verbatim (D82) — "end_turn", "max_tokens", …
      finishReason: typeof body.stop_reason === "string" ? body.stop_reason : "",
    };
  },
};

/**
 * A Message's content is a list of blocks; only the text ones are what a person
 * reads, and a multi-block reply reads as one paragraph run. Tool-use blocks
 * are dropped rather than JSON-dumped into the completion column.
 */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block!.text as string)
    .join("");
}
