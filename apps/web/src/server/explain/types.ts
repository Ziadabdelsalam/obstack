import "server-only";
import type { Trace } from "@/lib/types";
import type { ExplainRefusal } from "./contract";

/**
 * The provider seam (D168's shape, borrowed from `billing/types.ts`): the ONE
 * thing that differs between fake mode and Anthropic mode is where the text
 * comes from. Prompt assembly, streaming, validation and the wire frame are the
 * same code in both — `engine.ts` — so the fake is not a stub of the Explain
 * path, it is the Explain path with the provider removed, and the paths CI and
 * the e2e drive walk are the paths a real key walks.
 */

/**
 * `OBSTACK_EXPLAIN_MODE`. `fake` is the default and the only mode CI ever runs
 * (U6: CI never spends). `anthropic` is `@anthropic-ai/sdk`, pointed either at
 * Anthropic (cloud) or at an Anthropic-compatible endpoint (self-hosted, D102)
 * — there is no third mode and no provider abstraction, which D102 refused.
 */
export type ExplainMode = "fake" | "anthropic";

/** What the provider is asked. Assembled once, by `prompt.ts`, from the trace alone. */
export interface ExplainPrompt {
  system: string;
  user: string;
}

export interface ExplainProvider {
  readonly mode: ExplainMode;
  /**
   * The refusal this provider owes the caller instead of a run, or `null` when
   * it can run. Checked BEFORE the quota is spent (D225): a deployment with no
   * model configured must not burn a customer's Explain run to tell them so.
   */
  unavailable(): ExplainRefusal | null;
  /**
   * The model's answer, in the chunks it arrives in. The trace the prompt was
   * built from comes along because the fake has to answer from somewhere: "the
   * provider removed" means the trace itself is the fake's model, and reparsing
   * its own prompt text to get the ids back would be a second format to keep in
   * step. The Anthropic path ignores it — the prompt is what it sends.
   */
  stream(prompt: ExplainPrompt, trace: Trace): AsyncIterable<string>;
}

/**
 * The model answered in a shape `validate.ts` cannot read. Its own class so the
 * route can tell "the model wrote nonsense" apart from "the provider is down" —
 * neither is a refusal, because a refusal is a product outcome we chose and
 * these are failures we report.
 */
export class ExplainFormatError extends Error {
  constructor(what: string) {
    super(`the model's answer ${what}`);
    this.name = "ExplainFormatError";
  }
}
