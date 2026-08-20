import "server-only";
import type { Trace } from "@/lib/types";
import { getExplain } from "./client";
import type { ExplainEvent } from "./contract";
import { buildExplainPrompt } from "./prompt";
import type { ExplainProvider } from "./types";
import { parseExplanation } from "./validate";

/**
 * One Explain run: prompt in, wire frame out (D227). This is the whole of what
 * differs between a fake run and a real one — nothing, except where the text
 * comes from. Prompt assembly, delta framing, id validation and the terminal
 * event are this function in both modes.
 *
 * The route calls it AFTER it has taken the workspace's Explain run (D225): a
 * provider failure after that point is a counted run with no refund path, which
 * is a deliberate trade — the alternative is a cap that a failing provider lets
 * a caller loop past.
 *
 * It yields deltas as they arrive and exactly one terminal event: a `result`,
 * or the provider's `refusal` when the deployment has no model behind it. It
 * THROWS (`ExplainFormatError`, or whatever the provider threw) rather than
 * inventing a terminal event — an answer we could not read is a failure to
 * report, not an explanation to render.
 */
export async function* explainTrace(
  trace: Trace,
  provider: ExplainProvider = getExplain(),
): AsyncGenerator<ExplainEvent> {
  const refusal = provider.unavailable();
  if (refusal) {
    yield refusal;
    return;
  }

  const prompt = buildExplainPrompt(trace);
  let answer = "";
  for await (const chunk of provider.stream(prompt, trace)) {
    answer += chunk;
    yield { type: "delta", text: chunk };
  }
  yield { type: "result", explanation: parseExplanation(answer, trace) };
}
