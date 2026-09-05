import "server-only";
import type { IncidentSubject } from "@/lib/incident-types";
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

/**
 * What the rail explains (D550). Two subjects, one discriminated union: a
 * trace (M3's original) or an incident (S7.4). The union is the seam's
 * SECOND argument everywhere — the prompt builder, the provider's `stream`,
 * the reference index — so a third subject is a third member here and the
 * compiler names every site that has to learn it, rather than a sibling
 * generator that copies the `unavailable()` short-circuit, the delta loop and
 * the single terminal event, three things whose divergence the panel's D227
 * parse cannot survive.
 */
export type ExplainSubject = { kind: "trace"; trace: Trace } | { kind: "incident"; incident: IncidentSubject };

/**
 * What a resolved citation links to — EXACTLY ONE key, and it is the key
 * `Explanation["evidence"][number]` carries, so `parseEvidence` spreads it in
 * rather than choosing one (D553). `spanId`/`logRef` are a trace's; `eventRef`
 * (an `evt_` alert event or a `chg_` change event) and `traceRef` are an
 * incident's.
 */
export type EvidenceReference =
  | { spanId: string }
  | { logRef: string }
  | { eventRef: string }
  | { traceRef: string };

/**
 * The ids the model is allowed to cite for one subject — the D102/D223 trust
 * boundary as a value. `refs` is the allowlist, keyed by the exact id the
 * prompt showed the model; `subject` is how the dropped-reference note names
 * what the id was not in (`"this trace"`, `"this incident's timeline"`). It is
 * built by `subject.ts` from the SAME rows the prompt described, which is what
 * makes a resolved citation a working link rather than a claim.
 */
export interface ReferenceIndex {
  subject: string;
  refs: ReadonlyMap<string, EvidenceReference>;
}

/** What the provider is asked. Assembled once, by `subject.ts`, from the subject alone. */
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
   * The model's answer, in the chunks it arrives in. The subject the prompt was
   * built from comes along because the fake has to answer from somewhere: "the
   * provider removed" means the subject itself is the fake's model, and
   * reparsing its own prompt text to get the ids back would be a second format
   * to keep in step. The Anthropic path ignores it — the prompt is what it sends.
   */
  stream(prompt: ExplainPrompt, subject: ExplainSubject): AsyncIterable<string>;
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
