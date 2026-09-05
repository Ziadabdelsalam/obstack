"use client";

import { useEffect, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { readExplainStream, type ExplainEvent } from "@/server/explain/contract";
import type { Explanation } from "@/lib/types";

/**
 * "Explain this trace", for real (D102/D230). Two ways in, one renderer:
 *
 *   - `prepared` is the demo's own explanation (`mock/stories.ts`), rendered
 *     the moment the panel opens — the fabricated typed-out RAF effect is gone,
 *     because a fake stream is a product behaviour we never had.
 *   - without it the panel POSTs the run to `/app/traces/<id>/explain` and
 *     renders the model's chunks as they actually arrive, then the validated
 *     summary that terminates the frame.
 *
 * There is no `prefers-reduced-motion` fork here: a real stream is progress and
 * not animation, so nothing about it is a motion preference to honour (D230).
 *
 * The evidence links are the point of the panel — a span reference selects that
 * span in the waterfall beside it, a log reference jumps to the correlated-log
 * rail. An item that carries neither renders as text with the drop already
 * stated in its detail (D223: the server drops a reference the trace does not
 * hold and says so, rather than linking somewhere that does not exist).
 */

/** Where a run has got to. `streaming` holds the raw chunks; the rest are terminal. */
export type ExplainRun =
  | { phase: "streaming"; text: string }
  | { phase: "answered"; explanation: Explanation }
  | { phase: "refused"; detail: string }
  | { phase: "truncated" }
  | { phase: "unreachable" };

export const RUN_START: ExplainRun = { phase: "streaming", text: "" };

/**
 * The frame, folded into what the panel shows. Exported because this is the
 * half of the panel that can be proven without a browser: the terminal event
 * decides the phase, and a `delta` after a terminal one cannot un-answer it.
 */
export function applyExplainEvent(run: ExplainRun, event: ExplainEvent): ExplainRun {
  switch (event.type) {
    case "delta":
      // Past a terminal event there is nothing left to stream: a well-formed
      // frame has none, and a malformed one does not get to un-answer the run.
      return run.phase === "streaming" ? { phase: "streaming", text: run.text + event.text } : run;
    case "result":
      return { phase: "answered", explanation: event.explanation };
    case "refusal":
      return { phase: "refused", detail: event.detail };
  }
}

/**
 * A stream that ended without a terminal event is a failed run, not a short
 * answer (contract.ts): the deltas it did produce are DROPPED rather than
 * rendered as if the model had finished.
 */
export function endOfStream(run: ExplainRun): ExplainRun {
  return run.phase === "streaming" ? { phase: "truncated" } : run;
}

/**
 * Did this outcome cost the workspace one of its runs? The route's order of
 * record (D225/D240) is the whole answer: a refusal is decided BEFORE the
 * increment and spends nothing, and everything past the increment — including a
 * provider that died mid-stream — is a counted run with no refund path.
 * `unreachable` never reached the increment either: the request did not get a
 * stream back at all.
 */
export function costsARun(run: ExplainRun): boolean {
  return run.phase === "answered" || run.phase === "truncated";
}

/** The counter line, off the plan's real numbers (D226) — no constant lives here. */
export function explainCounterLine(used: number, quota: number): string {
  return `${used} of ${quota} Explain runs used this month`;
}

/**
 * The two non-refusal endings, worded as what happened rather than as an error
 * line — they are read by a person, and the D206 predicate reads anything the
 * product logs on an authenticated path.
 */
export const TRUNCATED_DETAIL =
  "The run stopped before it produced a summary, so there is nothing here to show. It still counted against this month's runs.";
export const UNREACHABLE_DETAIL =
  "This Explain run could not be started, so nothing ran and nothing was counted.";

/**
 * One run, from the POST to the terminal state. Separated from the component
 * because this is the half that can be proven: given a frame on the wire, this
 * is what the panel ends up showing, and a change to either side of the
 * contract shows up here rather than only in a browser.
 *
 * `onState` is called for every state the run passes through — the deltas are
 * the render, not a progress bar around one.
 */
export async function runExplain(
  url: string,
  signal: AbortSignal,
  onState: (run: ExplainRun) => void,
): Promise<ExplainRun> {
  let latest = RUN_START;
  let response: Response;
  try {
    // A run is a spend, so it is a POST and it is never retried on our side
    // (D189/D227). The URL is the caller's (S7.4, D552): this panel posts to
    // `/app/traces/<id>/explain` and the incident panel to
    // `/app/incidents/<id>/rca`, and the fold from the frame to a phase is the
    // same for both — which is why this function is exported and takes a url
    // rather than a trace id.
    response = await fetch(url, { method: "POST", signal });
  } catch {
    return { phase: "unreachable" };
  }
  // A status code here is a non-product outcome — no session, no such trace
  // (D241). Refusals never arrive this way; they are 200s carrying a terminal
  // `refusal` event, which is why there is no status fork below this line.
  if (!response.ok || !response.body) return { phase: "unreachable" };
  try {
    for await (const event of readExplainStream(response.body)) {
      latest = applyExplainEvent(latest, event);
      onState(latest);
    }
  } catch {
    // The connection died, or a line arrived that is not the frame. Either way
    // the run has no terminal event, which is the same thing as a truncated one.
    return endOfStream(latest);
  }
  return endOfStream(latest);
}

export function ExplainPanel({
  traceId,
  prepared,
  used,
  quota,
  logsHref,
  onSelectSpan,
  onFinished,
  onClose,
}: {
  traceId: string;
  /**
   * An explanation already in hand: the demo's prepared story, or the answer a
   * run on this page already produced. Either way the panel renders it and does
   * NOT fetch — reopening a closed panel must not spend a second metered run
   * (D189/D225) to show the reader the answer they just had.
   */
  prepared?: Explanation;
  /** the plan's Explain month, resolved on the server by the one quota reader */
  used: number;
  quota: number;
  /** the correlated-log rail's anchor on this page — where a `logRef` lands */
  logsHref: string;
  onSelectSpan: (spanId: string) => void;
  /**
   * How a run ends, handed to the page: it owns the counter (a run this panel
   * spent is not in the number the server rendered) and it keeps the answer, so
   * the panel can be closed and reopened without running again.
   */
  onFinished: (run: ExplainRun) => void;
  onClose: () => void;
}) {
  const [run, setRun] = useState<ExplainRun>(RUN_START);

  useEffect(() => {
    if (prepared) return;
    // The abort is the "the reader went away" half of the route's `cancel()`: a
    // closed panel stops asking the provider for chunks.
    const abort = new AbortController();
    void runExplain(`/app/traces/${encodeURIComponent(traceId)}/explain`, abort.signal, setRun).then((final) => {
      if (abort.signal.aborted) return;
      setRun(final);
      onFinished(final);
    });
    return () => abort.abort();
    // `onFinished` is deliberately not a dependency: re-running this effect is
    // spending another of the workspace's runs, and only the trace decides that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceId, prepared]);

  const explanation = prepared ?? (run.phase === "answered" ? run.explanation : null);
  const running = !prepared && run.phase === "streaming";

  return (
    <div
      className="rounded-lg border bg-raised"
      style={{ borderColor: "color-mix(in srgb, var(--color-llm) 35%, var(--color-line))" }}
    >
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span
          className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest"
          style={{ color: "var(--color-llm)" }}
        >
          <Sparkles className="h-3.5 w-3.5" />
          explain this trace
          {running && <span className="pulse-dot text-faint">analyzing…</span>}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close explanation"
          className="rounded p-1 text-faint hover:bg-overlay hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Polite, not assertive: the run arrives while the reader is looking at
          the trace, so the answer is worth announcing without interrupting
          whatever they were reading on the way. Busy while it runs, because a
          live region that announced every chunk would read the same growing
          paragraph over and over — the finished answer is announced once. */}
      <div className="space-y-3 px-3.5 py-3" aria-live="polite" aria-busy={running}>
        {explanation ? (
          <Summary explanation={explanation} logsHref={logsHref} onSelectSpan={onSelectSpan} />
        ) : run.phase === "streaming" ? (
          // The model's own chunks, as they land. The labelled document is what
          // the model writes (`server/explain/validate.ts`) and it reads as text
          // the whole way through — which is why the stream is shown at all.
          <p className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-mid">
            {run.text}
          </p>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-mid">
            {run.phase === "refused"
              ? run.detail
              : run.phase === "truncated"
                ? TRUNCATED_DETAIL
                : UNREACHABLE_DETAIL}
          </p>
        )}
      </div>

      {(prepared || run.phase !== "streaming") && (
        <div className="border-t border-line px-3.5 py-2 font-mono text-[10px] text-faint">
          {explainCounterLine(used, quota)}
        </div>
      )}
    </div>
  );
}

function Field({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-0.5 font-mono text-[9.5px] uppercase tracking-widest text-faint">{label}</p>
      <p className="text-[12.5px] leading-relaxed text-mid">{text}</p>
    </div>
  );
}

function Summary({
  explanation,
  logsHref,
  onSelectSpan,
}: {
  explanation: Explanation;
  logsHref: string;
  onSelectSpan: (spanId: string) => void;
}) {
  const linkClass =
    "mt-0.5 font-mono text-[10px] underline decoration-dotted underline-offset-2 hover:text-ink";
  return (
    <>
      <p className="text-[13.5px] font-medium leading-snug text-ink">{explanation.headline}</p>
      <Field label="WHAT FAILED" text={explanation.failedWhere} />
      <Field label="ROOT CAUSE" text={explanation.rootCause} />
      {explanation.evidence.map((item, i) => (
        <div key={i}>
          <p className="mb-0.5 font-mono text-[9.5px] uppercase tracking-widest text-faint">
            EVIDENCE · {item.label}
          </p>
          <p className="text-[12.5px] leading-relaxed text-mid">{item.detail}</p>
          {item.spanId ? (
            <button
              type="button"
              onClick={() => onSelectSpan(item.spanId as string)}
              className={`${linkClass} block text-faint`}
            >
              show this span
            </button>
          ) : item.logRef ? (
            <a href={logsHref} className={`${linkClass} block text-faint`}>
              show the correlated logs
            </a>
          ) : null}
        </div>
      ))}
      <Field label="SUGGESTED FIX" text={explanation.suggestion} />
    </>
  );
}
