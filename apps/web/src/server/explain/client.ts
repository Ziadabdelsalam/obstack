import "server-only";
import { createAnthropicExplain } from "./anthropic";
import { fakeExplain } from "./fake";
import type { ExplainMode, ExplainProvider } from "./types";

/**
 * Which provider the process talks to, the `billingMode()` seam verbatim
 * (D168). `OBSTACK_EXPLAIN_MODE` DEFAULTS TO `fake`, and the consequences are
 * the reason it is that way round:
 *
 *  - CI sets nothing, so CI runs the fake, so no Anthropic key has ever entered
 *    GitHub Actions and no CI run has ever spent a token (U6).
 *  - A deployment that means to call a model has to say so, and `anthropic`
 *    with no key REFUSES in the surface ("no model is configured") instead of
 *    quietly falling back to the fake — a fallback there would show a person a
 *    restatement of their trace as though a model had read it.
 */
export function explainMode(): ExplainMode {
  const raw = process.env.OBSTACK_EXPLAIN_MODE ?? "fake";
  if (raw !== "fake" && raw !== "anthropic") {
    throw new Error(`OBSTACK_EXPLAIN_MODE must be "fake" or "anthropic", got "${raw}"`);
  }
  return raw;
}

/** Exported beside `getExplain` so the mode seam itself is testable, refusal included. */
export function createExplainProvider(mode: ExplainMode): ExplainProvider {
  return mode === "fake" ? fakeExplain : createAnthropicExplain();
}

let provider: ExplainProvider | undefined;

/** The one instance, built on first use (D114: fake mode boots with no Anthropic env at all). */
export function getExplain(): ExplainProvider {
  if (!provider) provider = createExplainProvider(explainMode());
  return provider;
}
