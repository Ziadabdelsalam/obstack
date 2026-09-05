import "server-only";
import type { Explanation } from "@/lib/types";
import { ExplainFormatError, type ReferenceIndex } from "./types";

/**
 * The model's answer, turned into an `Explanation` we are willing to render.
 *
 * The answer format is a labelled plain-text document rather than JSON, for one
 * product reason: the panel streams the raw chunks as they arrive (D230 — a
 * real stream is progress, not animation), and a half-written JSON object is
 * not something to show a person. Labelled lines read as text the whole way
 * through and parse deterministically at the end.
 *
 *     HEADLINE: one sentence
 *     WHERE: the layer/service the failure happened in
 *     CAUSE: what actually went wrong
 *     EVIDENCE: <an id the subject holds, or -> | label | detail
 *     SUGGESTION: what to do next
 *
 * ONE format for both subjects (D552): an incident's RCA is the same five
 * labels, the same separator, the same parse and the same error class as a
 * trace's Explain. There is no second label set and no second validator — a
 * sweep in `explain.test.ts` asserts this file holds the only `LABELS` table.
 *
 * TRUST BOUNDARY (D102): every id the model writes is checked against the ids
 * the subject actually contains — the `ReferenceIndex` `subject.ts` built from
 * the subject's own rows, the ones the page renders (D553). A model that
 * invents a span id or
 * an `evt_` id would otherwise put a link in the product that goes nowhere —
 * worse than no link, because it looks like a fact we hold. An unrecognised id
 * is DROPPED and the drop is stated on the evidence line itself, so the user
 * reads "we could not stand behind this reference" instead of silently getting
 * an unlinked line.
 *
 * THE SERVER LOG IS A TRUST BOUNDARY TOO (D248): model-supplied content never
 * enters the server log at any level. There is no level that is safe to write
 * it at — `console.debug` is stdout like the rest, and the e2e drive reads
 * every line of an authenticated run unleveled and fails on anything matching
 * its error regex, so a model that wrote "Error" into an id it invented could
 * turn a correct run red. What operators need is the fact of a drop and how
 * many there were, and that line is fully static. The panel is where untrusted
 * content is shown — stated as untrusted, in `droppedReferenceNote`.
 */

/** The document's labels, exported because `prompt.ts` writes the instructions from them. */
export const LABELS = {
  headline: "HEADLINE",
  where: "WHERE",
  cause: "CAUSE",
  evidence: "EVIDENCE",
  suggestion: "SUGGESTION",
} as const;

/** The separator inside an EVIDENCE line: reference, label, detail. */
export const EVIDENCE_SEPARATOR = "|";

/** No reference for this line — the model saying so, rather than reaching for an id. */
export const NO_REFERENCE = "-";

/**
 * How the trace subject is named in the dropped-reference note — the DEFAULT
 * below, and `traceReferences`' own name for itself, one definition. The string
 * the note emits for a trace is pinned by `deploy/compose/e2e-drive.mjs`
 * (`"is not in this trace"`), so the default is what keeps the trace path
 * byte-identical now that the note can name a second subject.
 */
export const TRACE_SUBJECT = "this trace";

/** How a dropped reference reads to the person looking at it. */
export function droppedReferenceNote(reference: string, subject: string = TRACE_SUBJECT): string {
  return `(reference ${reference} is not in ${subject}, so it is not linked)`;
}

/**
 * Model output on its way onto a person's screen. The reference is flattened,
 * clipped and quoted before it is rendered, so an invented id reads as the
 * bounded quoted string it is and cannot rewrite the line it sits in.
 */
function safeReference(raw: string): string {
  return JSON.stringify(raw.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 64));
}

export function parseExplanation(raw: string, refs: ReferenceIndex): Explanation {
  const fields = new Map<string, string>();
  const evidence: Explanation["evidence"] = [];
  /** The references we refused to link — only how many of them reaches the log. */
  const dropped: string[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    // Model output is untrusted text on its way to a person's screen (never to
    // a log line — D248). Control characters are flattened HERE, at the parse
    // boundary, so every field below is already clean — a bare carriage return would
    // otherwise cut a line short (`.` does not cross one) and quietly drop the
    // evidence it was hiding in.
    const line = rawLine.replace(/[\u0000-\u001f\u007f]+/g, " ");
    const match = /^\s*([A-Z]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, label, value] = match;
    if (label === LABELS.evidence) {
      const item = parseEvidence(value, refs, dropped);
      if (item) evidence.push(item);
    } else if (value.trim()) {
      // First occurrence wins: a model that restates a label has changed its
      // mind out loud, and the answer we keep is the one we already streamed.
      if (!fields.has(label)) fields.set(label, value.trim());
    }
  }

  const headline = fields.get(LABELS.headline);
  const failedWhere = fields.get(LABELS.where);
  const rootCause = fields.get(LABELS.cause);
  const suggestion = fields.get(LABELS.suggestion);
  if (!headline || !failedWhere || !rootCause || !suggestion) {
    throw new ExplainFormatError(
      `is missing ${[LABELS.headline, LABELS.where, LABELS.cause, LABELS.suggestion]
        .filter((label) => !fields.get(label))
        .join(", ")}`,
    );
  }
  if (evidence.length === 0) {
    throw new ExplainFormatError(`cites no ${LABELS.evidence}`);
  }

  if (dropped.length > 0) {
    // `warn`, not `error` (D193): a model reaching for an id we do not hold is
    // a model behaviour we expect and handle, not an anomaly in our own rail.
    // Static wording plus a count we computed — the references themselves are
    // the model's words and never reach the log at all (D248); the reader sees
    // each one in the panel, on the evidence line it was dropped from.
    console.warn("[explain] dropped evidence references the subject does not contain:", dropped.length);
  }

  return { headline, failedWhere, rootCause, evidence, suggestion };
}

function parseEvidence(
  value: string,
  refs: ReferenceIndex,
  dropped: string[],
): Explanation["evidence"][number] | null {
  const parts = value.split(EVIDENCE_SEPARATOR);
  if (parts.length < 3) return null;
  const reference = parts[0].trim();
  const label = parts[1].trim();
  // Everything after the second separator is detail: a sentence is allowed to
  // contain the separator, and the two fields before it are not.
  const detail = parts.slice(2).join(EVIDENCE_SEPARATOR).trim();
  if (!label || !detail) return null;

  if (!reference || reference === NO_REFERENCE) return { label, detail };
  // The allowlist decides both WHETHER the id links and WHICH key carries it:
  // the reference is spread in whole, so exactly one of the four keys is set.
  const found = refs.refs.get(reference);
  if (found) return { label, detail, ...found };

  const quoted = safeReference(reference);
  dropped.push(quoted);
  return { label, detail: `${detail} ${droppedReferenceNote(quoted, refs.subject)}` };
}
