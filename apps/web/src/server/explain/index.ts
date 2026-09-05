import "server-only";

/**
 * The one server-side import path for Explain: `@/server/explain`. What is
 * behind it — the two providers, the mode selector, prompt assembly and the
 * validation that drops an id the trace does not hold — is this directory's
 * business, and a caller that reached past this barrel would be a second place
 * that knows what a model looks like (the D110 boundary).
 *
 * ONE deliberate exception: `@/server/explain/contract` is imported directly by
 * the panel, because the panel is a client component and the wire frame is the
 * one thing both sides of the request must agree on (D227). That file imports
 * nothing server-side, which is what keeps the exception narrow.
 */
export { createExplainProvider, explainMode, getExplain } from "./client";
export { explainSubject } from "./engine";
export { NOT_CONFIGURED_DETAIL } from "./anthropic";
export { NO_EVIDENCE_DETAIL } from "./incident-prompt";
export { overQuotaDetail } from "./quota";
export { explainResponse, oneEvent } from "./response";
export { fakeExplainDocument, fakeIncidentDocument } from "./fake";
export { ExplainFormatError } from "./types";
export type { EvidenceReference, ExplainMode, ExplainPrompt, ExplainProvider, ExplainSubject, ReferenceIndex } from "./types";
