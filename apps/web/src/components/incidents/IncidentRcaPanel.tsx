"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  RUN_START,
  TRUNCATED_DETAIL,
  UNREACHABLE_DETAIL,
  costsARun,
  explainCounterLine,
  runExplain,
  type ExplainRun,
} from "@/components/trace/ExplainPanel";
import type { Explanation } from "@/lib/types";

/**
 * Root-cause analysis on the LIVE incident detail (S7.4 packet D552/D555),
 * which is the Explain rail's second subject rendered by the Explain panel's
 * own fold: `runExplain` POSTs the run and turns the wire frame into a phase,
 * `costsARun` says whether the ending was counted, `explainCounterLine` is the
 * one counter sentence, and the two ending details are the ones the trace
 * panel already reads to the user. This file imports all of that and owns only
 * what differs for an incident:
 *
 *   - AN EXPLICIT TRIGGER. The trace panel runs when it opens, because opening
 *     it IS the click. An incident page is a page view, and a page view is
 *     never a spend — the free plan is a small monthly allowance — so nothing
 *     here runs until the reader presses the control, and the counter line is
 *     shown BEFORE they do, beside it.
 *   - A RETAINED ANSWER. `prepared` is the answer a run on this page already
 *     produced; the panel renders it and does not run. The RCA is not stored
 *     (D555), so the page is what keeps it, and closing and reopening must not
 *     spend a second run to show the reader what they just had.
 *   - `canRunRca`. The page hides the control when the timeline holds no read
 *     row (D558): the route would refuse `no-evidence` free, but a control that
 *     leads to a refusal by construction is not a control.
 *   - ITS OWN CAPTIONS and its own two links (D553): an `eventRef` is a row on
 *     THIS page, so it is an in-page anchor `#<id>` — the timeline anchors each
 *     row on its key, which for an alert or change event is the event's id;
 *     a `traceRef` is a `<Link>` to `/app/traces/<id>`, a route that exists.
 *
 * What is NOT here: the mock's six RCA headings (they stay in `IncidentRca.tsx`,
 * mock-only, byte-pinned — D552), any quota literal (D226: the numbers come
 * from the plan row through `used`/`quota`), and any `requestAnimationFrame`
 * or `prefers-reduced-motion` fork: a real stream is progress, not animation
 * (D230), so nothing about it is a motion preference to honour. The fixture
 * typewriter in `IncidentRca.tsx` animates a story nothing ever streamed, on a
 * page whose bytes are pinned; it is not imported here and must not be.
 */

/** The run's POST url — the caller's half of `runExplain`'s contract. */
export function rcaUrl(incidentId: string): string {
  return `/app/incidents/${encodeURIComponent(incidentId)}/rca`;
}

/**
 * The counter after a run, for the page that owns the number: the server
 * rendered `used` before the run, and a run that got past the increment is one
 * more. A refusal or an unreachable route moved nothing (D225/D240).
 */
export function usedAfter(used: number, run: ExplainRun): number {
  return used + (costsARun(run) ? 1 : 0);
}

export function IncidentRcaPanel({
  incidentId,
  prepared,
  used,
  quota,
  canRunRca,
  onFinished,
}: {
  incidentId: string;
  /** The answer a run on this page already produced — rendered, never re-run. */
  prepared?: Explanation;
  /** The plan's Explain month, resolved on the server by the one quota reader. */
  used: number;
  quota: number;
  /** False when the stitched timeline holds no read row: the control is not rendered. */
  canRunRca: boolean;
  /**
   * How a run ends, handed to the page: it keeps the answer (so a reopen renders
   * `prepared` and spends nothing) and it owns the counter (`usedAfter`).
   */
  onFinished: (run: ExplainRun) => void;
}) {
  /** null until the reader presses the control — a page view never runs. */
  const [run, setRun] = useState<ExplainRun | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // The abort is the "the reader went away" half of the route's `cancel()`: a
  // panel that unmounts mid-run stops asking the provider for chunks. Nothing
  // is STARTED here — the only way a run begins is `start`, below.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const start = () => {
    const abort = new AbortController();
    abortRef.current = abort;
    setRun(RUN_START);
    void runExplain(rcaUrl(incidentId), abort.signal, setRun).then((final) => {
      if (abort.signal.aborted) return;
      setRun(final);
      onFinished(final);
    });
  };

  const explanation = prepared ?? (run?.phase === "answered" ? run.explanation : null);
  const running = !prepared && run?.phase === "streaming";

  if (!explanation && run === null) {
    if (!canRunRca) return null;
    return (
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={start}
          className="flex w-full items-center justify-center gap-2 rounded-lg border py-3 text-[13.5px] font-medium transition-colors"
          style={{
            color: "var(--color-llm)",
            borderColor: "color-mix(in srgb, var(--color-llm) 40%, var(--color-line))",
            background: "color-mix(in srgb, var(--color-llm) 6%, transparent)",
          }}
        >
          <Sparkles className="h-4 w-4" />
          Generate root-cause analysis
          <span className="font-mono text-[10px] uppercase tracking-widest opacity-70">one Explain run</span>
        </button>
        <p className="text-center font-mono text-[10px] text-faint">{explainCounterLine(used, quota)}</p>
      </div>
    );
  }

  return (
    <div
      className="mt-4 rounded-lg border bg-raised"
      style={{ borderColor: "color-mix(in srgb, var(--color-llm) 35%, var(--color-line))" }}
    >
      <div className="flex items-center justify-between border-b border-line px-3.5 py-2">
        <span
          className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest"
          style={{ color: "var(--color-llm)" }}
        >
          <Sparkles className="h-3.5 w-3.5" />
          root-cause analysis
          {running && <span className="pulse-dot text-faint">reading the timeline…</span>}
        </span>
      </div>

      {/* Polite and busy while it runs, for the reason the trace panel gives:
          the finished answer is announced once, not every chunk. */}
      <div className="space-y-3 px-4 py-3.5" aria-live="polite" aria-busy={running}>
        {explanation ? (
          <Summary explanation={explanation} />
        ) : run?.phase === "streaming" ? (
          // The model's own chunks, as they land — the labelled document reads
          // as text the whole way through, which is why the stream is shown.
          <p className="whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-mid">{run.text}</p>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-mid">
            {run?.phase === "refused"
              ? run.detail
              : run?.phase === "truncated"
                ? TRUNCATED_DETAIL
                : UNREACHABLE_DETAIL}
          </p>
        )}
      </div>

      {(prepared || run?.phase !== "streaming") && (
        <div className="border-t border-line px-4 py-2 font-mono text-[10px] leading-relaxed text-faint">
          {explainCounterLine(used, quota)} · generated from this incident&apos;s timeline — review before
          publishing; this is a draft, not a verdict.
        </div>
      )}
    </div>
  );
}

function Field({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-0.5 font-mono text-[9.5px] uppercase tracking-widest text-faint">{label}</p>
      <p className="text-[13px] leading-relaxed text-mid">{text}</p>
    </div>
  );
}

function Summary({ explanation }: { explanation: Explanation }) {
  const linkClass =
    "mt-0.5 block font-mono text-[10px] text-faint underline decoration-dotted underline-offset-2 hover:text-ink";
  return (
    <>
      <p className="text-[13.5px] font-medium leading-snug text-ink">{explanation.headline}</p>
      <Field label="WHERE" text={explanation.failedWhere} />
      <Field label="ROOT CAUSE" text={explanation.rootCause} />
      {explanation.evidence.map((item, i) => (
        <div key={i}>
          <p className="mb-0.5 font-mono text-[9.5px] uppercase tracking-widest text-faint">
            EVIDENCE · {item.label}
          </p>
          <p className="text-[13px] leading-relaxed text-mid">{item.detail}</p>
          {item.eventRef ? (
            <a href={`#${item.eventRef}`} className={linkClass}>
              show this row on the timeline
            </a>
          ) : item.traceRef ? (
            <Link href={`/app/traces/${encodeURIComponent(item.traceRef)}`} className={linkClass}>
              open the example trace
            </Link>
          ) : null}
        </div>
      ))}
      <Field label="WHAT TO DO NEXT" text={explanation.suggestion} />
    </>
  );
}
