import "server-only";
import { getExplain } from "./client";
import type { ExplainEvent } from "./contract";
import { buildPrompt, referenceIndex } from "./subject";
import type { ExplainProvider, ExplainSubject } from "./types";
import { parseExplanation } from "./validate";

/**
 * One Explain run: prompt in, wire frame out (D227). This is the whole of what
 * differs between a fake run and a real one — nothing, except where the text
 * comes from. Prompt assembly, delta framing, id validation and the terminal
 * event are this function in both modes.
 *
 * And in both SUBJECTS (D550): a trace's Explain and an incident's RCA are this
 * one generator, differing only in the two table lookups `subject.ts` owns —
 * which prompt to build and which ids the model may cite. A sibling generator
 * per subject would copy the `unavailable()` short-circuit, the delta loop and
 * the single terminal event, three things whose divergence the panel's D227
 * parse cannot survive.
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
export async function* explainSubject(
  subject: ExplainSubject,
  provider: ExplainProvider = getExplain(),
): AsyncGenerator<ExplainEvent> {
  const refusal = provider.unavailable();
  if (refusal) {
    yield refusal;
    return;
  }

  const prompt = buildPrompt(subject);
  let answer = "";
  for await (const chunk of provider.stream(prompt, subject)) {
    answer += chunk;
    yield { type: "delta", text: chunk };
  }
  yield { type: "result", explanation: parseExplanation(answer, referenceIndex(subject)) };
}
