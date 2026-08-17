/**
 * The D8 interop contract, expressed once.
 *
 * Every attribute name obstack-js puts on a span is declared here and nowhere
 * else in `src/` (D81). The names are not this SDK's to choose: ingest reads
 * them in `services/ingest/internal/mapping/mapping.go`, and a typo does not
 * fail a build — it produces a span that lands in ClickHouse classified as
 * `other`, with no model, no tokens and no cost. Because the failure is silent
 * and downstream, the Go side pins this file: `sdk_contract_test.go` reads it
 * and asserts every literal below still appears verbatim, so the contract owner
 * catches the drift rather than the consumer.
 *
 * Two D8 names are deliberately absent:
 *
 *   - `gen_ai.response.finish_reason` (scalar). D8-AMENDMENT accepts either the
 *     scalar or the `…finish_reasons[0]` array form; D82 picks the array, so
 *     only FINISH_REASONS exists. (The scalar name is a prefix of the array one,
 *     which is why a verbatim-substring pin on the Go side still finds it.)
 *   - `layer`. Ingest classifies; an SDK that set the layer itself would be
 *     asserting a decision that is not its to make (D82).
 *
 * And two whole mechanisms are absent on purpose: no span EVENTS carry GenAI
 * content (D38 FINAL — ingest does not read that wire form, so an event-form
 * span lands unreadable), and no cost or pricing attribute exists here (D9 —
 * ingest computes cost from tokens and model).
 */

/** `gen_ai.system` — the provider, as the bare vendor name. */
export const GEN_AI_SYSTEM = "gen_ai.system";
/** `gen_ai.request.model` — the model the caller asked for. */
export const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
/** `gen_ai.response.model` — the model the provider says answered. */
export const GEN_AI_RESPONSE_MODEL = "gen_ai.response.model";
/** `gen_ai.usage.input_tokens` — int, straight from the provider's usage block. */
export const GEN_AI_INPUT_TOKENS = "gen_ai.usage.input_tokens";
/** `gen_ai.usage.output_tokens` — int, straight from the provider's usage block. */
export const GEN_AI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";
/**
 * `gen_ai.prompt` — the request's messages array as a JSON string, verbatim
 * order (D82). Ingest moves it into a dedicated ZSTD column and strips it from
 * the attributes Map, so nothing downstream may read it back from there
 * (D8-AMENDMENT, carry-forward 4).
 */
export const GEN_AI_PROMPT = "gen_ai.prompt";
/**
 * `gen_ai.completion` — the assistant's reply as plain text, the thing a human
 * reads (D82). Same dedicated-column treatment as the prompt.
 */
export const GEN_AI_COMPLETION = "gen_ai.completion";
/** `gen_ai.response.finish_reasons` — single-element array (D82). */
export const GEN_AI_FINISH_REASONS = "gen_ai.response.finish_reasons";

/** `obstack.agent.step` — what makes ingest classify a span as the agent layer. */
export const OBSTACK_AGENT_STEP = "obstack.agent.step";
/** `obstack.tool.name` — what makes ingest classify a span as the tool layer. */
export const OBSTACK_TOOL_NAME = "obstack.tool.name";

/** The `gen_ai.system` value for OpenAI-shaped calls (D82). */
export const SYSTEM_OPENAI = "openai";
/** The `gen_ai.system` value for Anthropic-shaped calls (D82). */
export const SYSTEM_ANTHROPIC = "anthropic";

/**
 * Span names live here too, beside the attribute each pairs with: the name and
 * the attribute are one emission decision, and splitting them is how the two
 * drift apart. `demo/agent-app` established `chat <model>` for LLM spans; the
 * `agent.`/`tool.` prefixes are what the four-layer trace reads as in the UI.
 */
export const agentSpanName = (step: string): string => `agent.${step}`;
export const toolSpanName = (name: string): string => `tool.${name}`;
export const llmSpanName = (model: string): string => `chat ${model}`;
