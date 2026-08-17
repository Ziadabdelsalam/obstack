/**
 * The D8 attribute names, restated on purpose.
 *
 * This is the only deliberate second copy of `src/attributes.ts` in the
 * package, and it exists because a conformance test that imports the constants
 * it is checking cannot fail: rename `GEN_AI_PROMPT`'s value and both sides
 * move together, the assertion still passes, and the SDK quietly starts
 * emitting an attribute ingest does not read. Written out as literals, the same
 * rename turns every suite red — which is the falsification S2.0 L1 asks for.
 *
 * So: if a test below goes red, the fix is in `src/attributes.ts`. Editing this
 * file to match the code is editing the contract to match the bug.
 *
 * (The Go side pins the same literals from the other direction —
 * `services/ingest/internal/mapping/sdk_contract_test.go` reads
 * `src/attributes.ts` and compares it to `mapping.go`, D81.)
 */
export const D8 = {
  system: "gen_ai.system",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  prompt: "gen_ai.prompt",
  completion: "gen_ai.completion",
  finishReasons: "gen_ai.response.finish_reasons",
  agentStep: "obstack.agent.step",
  toolName: "obstack.tool.name",
} as const;

/** Every GenAI attribute an LLM span must carry to be complete in the UI:
 *  a missing one costs the model, the token counts or the cost column. */
export const D8_LLM_ATTRIBUTES = [
  D8.system,
  D8.requestModel,
  D8.responseModel,
  D8.inputTokens,
  D8.outputTokens,
  D8.prompt,
  D8.completion,
  D8.finishReasons,
] as const;
