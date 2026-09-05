import "server-only";
import type { IncidentSubject } from "@/lib/incident-types";
import type { Trace } from "@/lib/types";
import { buildIncidentPrompt, describedIncidentRows } from "./incident-prompt";
import { buildExplainPrompt } from "./prompt";
import type { EvidenceReference, ExplainPrompt, ExplainSubject, ReferenceIndex } from "./types";
import { TRACE_SUBJECT } from "./validate";

/**
 * The two-entry dispatch behind the seam (D550): what a subject is asked as,
 * and which ids it lets the model cite. Both come from the SAME object, and the
 * incident's allowlist from the SAME rows its prompt describes (D553) — that
 * identity is what makes a resolved citation a working link rather than a
 * claim about an id the page never showed.
 *
 * `engine.ts` is the only caller of `buildPrompt`/`referenceIndex`; the two
 * per-subject builders are exported for the tests that pin what each subject
 * lets through, and for the "same code in both modes" twin.
 */

/** How the incident subject is named in the dropped-reference note (D553). */
export const INCIDENT_SUBJECT = "this incident's timeline";

export function buildPrompt(subject: ExplainSubject): ExplainPrompt {
  switch (subject.kind) {
    case "trace":
      return buildExplainPrompt(subject.trace);
    case "incident":
      return buildIncidentPrompt(subject.incident);
  }
}

export function referenceIndex(subject: ExplainSubject): ReferenceIndex {
  switch (subject.kind) {
    case "trace":
      return traceReferences(subject.trace);
    case "incident":
      return incidentReferences(subject.incident);
  }
}

/** A trace's citable ids: its span ids and its correlated log ids (D223). */
export function traceReferences(trace: Trace): ReferenceIndex {
  const refs = new Map<string, EvidenceReference>();
  for (const span of trace.spans) if (!refs.has(span.id)) refs.set(span.id, { spanId: span.id });
  for (const log of trace.logs) if (!refs.has(log.id)) refs.set(log.id, { logRef: log.id });
  return { subject: TRACE_SUBJECT, refs };
}

/**
 * An incident's citable ids (D553): `evt_` alert events and `chg_` change
 * events as `eventRef`, trace ids as `traceRef` — every one of them an id a
 * store this workspace owns already holds, keyed by the row's LEG rather than
 * by an id prefix, because the leg is what the stitch stated and the page
 * anchors on.
 *
 * Built from `describedIncidentRows(incident.rows)` and NOT from
 * `incident.rows` — the rows the PROMPT described, which on a busy incident are
 * a strict subset of the rows the subject carries (D554 caps per lane at
 * 60/40/20; the stitch hands up to 170). ⟨S7.4 T5 plan correction, D578: D553
 * says the allowlist is built from "the SAME rows the prompt described and the
 * page renders", assuming those are one set. They are not, and when they
 * differ the allowlist follows the PROMPT: a citation is the model's claim
 * about a row it read, and an id the model was never shown cannot be a
 * grounded citation of it even when the id happens to name a real row on the
 * page. Following the page would let a cap-dropped id — reachable only by the
 * model inventing a string that collides with a real row — resolve to a
 * working link the analysis never actually read. `cited ⇔ given` is the
 * property; the exported `describedIncidentRows` is the one function both
 * sides read.⟩
 *
 * Three exclusions, each a fabricated link avoided: a row with no id has
 * nothing to cite; the incident's OWN id is never citable, even if a row
 * carried it, because citing the subject as evidence for itself links to the
 * page the reader is standing on (the one self-reference a model reliably
 * reaches for); and a duplicate id from the window join keeps its FIRST row's
 * reference, so a later duplicate cannot move the anchor. Metric points never
 * enter: the timeseries has no row identity, and minting one would be inventing
 * a fact.
 */
export function incidentReferences(incident: IncidentSubject): ReferenceIndex {
  const refs = new Map<string, EvidenceReference>();
  for (const row of describedIncidentRows(incident.rows)) {
    if (row.id === null || row.id === incident.id || refs.has(row.id)) continue;
    refs.set(row.id, row.kind === "trace" ? { traceRef: row.id } : { eventRef: row.id });
  }
  return { subject: INCIDENT_SUBJECT, refs };
}
