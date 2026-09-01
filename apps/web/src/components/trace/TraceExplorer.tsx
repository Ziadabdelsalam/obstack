"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Link2, Sparkles, Check, GitCompareArrows } from "lucide-react";
import { fmtCost, fmtMs, fmtTokens, timeAgo } from "@/lib/format";
import { layerColor } from "@/lib/layers";
import { NEARBY_LOG_CAP, NEARBY_LOG_WINDOW_S } from "@/lib/nearby-logs";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Explanation, Trace } from "@/lib/types";
import { Waterfall } from "./Waterfall";
import { SpanDetail } from "./SpanDetail";
import { LogsRail } from "./LogsRail";
import { ExplainPanel, costsARun } from "./ExplainPanel";
import { AgentReplay } from "./AgentReplay";

/** One definition of the correlated-log rail's anchor: the section carries it, the evidence links reach for it. */
const LOGS_ANCHOR = "correlated-logs";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className="font-mono text-[12px] text-ink">{value}</span>
    </span>
  );
}

/**
 * `compare` is the diff link, already resolved (D400): the page computes it per
 * mode — mock mode picks the healthy counterpart out of the mock corpus, live
 * mode links to the diff with this trace as side A — and null means this trace
 * has nothing to compare against. It arrives as an href rather than a flag
 * because the mock corpus is what a partner lookup needs, and this is a client
 * component: reading `@/mock/traces` here shipped the whole demo dataset to the
 * browser on a live trace page.
 *
 * `explain` is the page's answer to both Explain questions, because both are
 * server facts: `live` says a run is fetched on demand from the route rather
 * than being the demo's prepared story (D224 — the adapter still never sets
 * `trace.explanation`), and `used`/`quota` is this workspace's Explain month as
 * the one quota reader read it (D226).
 */
export function TraceExplorer({
  trace,
  nowMs,
  compare,
  explain,
}: {
  trace: Trace;
  /** the request's reference clock, per mode (D50/D64) — never sampled here */
  nowMs: number;
  compare: { href: string } | null;
  explain: { live: boolean; used: number; quota: number };
}) {
  const firstError = useMemo(
    () => trace.spans.find((s) => s.status === "error"),
    [trace],
  );
  const [selectedId, setSelectedId] = useState<string>(
    (firstError ?? trace.spans[0]).id,
  );
  const [explainOpen, setExplainOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // A run this page session spent, held HERE rather than in the panel, because
  // the panel unmounts when it is closed: the answer survives a close so that
  // reopening shows it again instead of quietly spending a second metered run,
  // and the count survives so the footer stops restating the number the server
  // read at page load.
  const [runsSpent, setRunsSpent] = useState(0);
  const [answered, setAnswered] = useState<Explanation | null>(null);
  const [view, setView] = useState<"waterfall" | "replay">("waterfall");
  const hasAgent = trace.spans.some((s) => s.layer === "agent");

  // There was a "share" button here that opened a modal around a made-up
  // `https://obstack.dev/share/…` link (D231.4). Public trace sharing is not
  // built, so the affordance and the URL are gone rather than re-worded — "copy
  // link" beside it copies the URL of this page, which is a link that works.

  const selected = trace.spans.find((s) => s.id === selectedId) ?? trace.spans[0];
  const hasFailure = trace.status === "error" || trace.spans.some((s) => s.status === "error");
  const solidCount = trace.logs.filter((l) => l.traceId).length;
  const nearbyCount = trace.logs.length - solidCount;
  // `nearbyLogsTruncated` is a known fact, not a guess (D13/D21): the adapter
  // only sets it when it saw NEARBY_LOG_CAP + 1 real rows, so — unlike a bare
  // `nearbyCount === NEARBY_LOG_CAP` check — it is never true for a window
  // that genuinely had exactly the cap and no more.
  const nearbyTruncated = trace.nearbyLogsTruncated === true;

  // service journey, in order of first activity — the pipeline this trace crossed
  const journey = useMemo(() => {
    const seen = new Map<string, { service: string; color: string }>();
    for (const s of [...trace.spans].sort((a, b) => a.startMs - b.startMs)) {
      if (!seen.has(s.service)) {
        seen.set(s.service, { service: s.service, color: layerColor[s.layer] });
      }
    }
    return [...seen.values()];
  }, [trace]);

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="px-5 py-4">
      {/* header */}
      <div className="mb-1 flex items-center gap-2">
        <Link
          href="/app/traces"
          className="flex items-center gap-1 text-[12px] text-faint hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> traces
        </Link>
        <span className="text-faint">/</span>
        <span className="font-mono text-[11px] text-faint">{trace.id}</span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate font-mono text-[17px] font-medium text-ink">
            {trace.rootName}
          </h1>
          <StatusPill status={trace.status} />
        </div>
        <div className="flex items-center gap-2">
          {hasAgent && (
            <div className="flex rounded-md border border-line bg-raised p-0.5">
              {(["waterfall", "replay"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-[5px] px-2.5 py-1 font-mono text-[11px] transition-colors ${
                    view === v ? "bg-overlay text-ink" : "text-faint hover:text-mid"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={copyLink}
            className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] text-mid hover:border-line-strong hover:text-ink"
          >
            {copied ? <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} /> : <Link2 className="h-3.5 w-3.5" />}
            {copied ? "copied" : "copy link"}
          </button>
          {compare && (
            <Link
              href={compare.href}
              className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] text-mid hover:border-line-strong hover:text-ink"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              diff vs healthy run
            </Link>
          )}
          {/* D224: in live mode a failure is the whole condition — the run is
              fetched on demand, so nothing has to be attached to the trace for
              the button to be true. Mock mode still needs its prepared story. */}
          {hasFailure && (explain.live || trace.explanation) && (
            <button
              type="button"
              onClick={() => setExplainOpen(true)}
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium text-bg transition-transform hover:scale-[1.02]"
              style={{ background: "var(--color-llm)" }}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Explain this trace
            </button>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-line pb-3">
        <Stat label="duration" value={fmtMs(trace.durationMs)} />
        <Stat label="spans" value={String(trace.spanCount)} />
        <Stat label="tokens" value={fmtTokens(trace.totalTokens)} />
        <Stat label="llm cost" value={fmtCost(trace.costUsd)} />
        <Stat label="services" value={trace.services.join(" · ")} />
        <Stat
          label="pods"
          value={String(new Set(trace.spans.map((s) => s.pod).filter(Boolean)).size)}
        />
        <Stat label="started" value={timeAgo(trace.startedAt, nowMs)} />
      </div>

      {/* the pipeline this trace traveled, trigger to finish */}
      {journey.length > 1 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-y-1">
          <span className="mr-3 font-mono text-[10px] uppercase tracking-wider text-faint">
            pipeline
          </span>
          {journey.map((j, i) => (
            <span key={j.service} className="flex items-center">
              {i > 0 && <ArrowRight className="mx-1.5 h-3 w-3 text-faint" />}
              <span className="flex items-center gap-1.5 rounded-[4px] border border-line bg-surface px-1.5 py-0.5">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: j.color }} />
                <span className="font-mono text-[11px] text-mid">{j.service}</span>
              </span>
            </span>
          ))}
        </div>
      )}

      {/* body */}
      {view === "replay" ? (
        <div className="mx-auto mt-4 max-w-2xl">
          <AgentReplay trace={trace} />
        </div>
      ) : (
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <section className="rounded-lg border border-line bg-surface p-3" data-tour="trace-waterfall">
            <Waterfall trace={trace} selectedId={selectedId} onSelect={setSelectedId} />
          </section>

          {/* The anchor an explanation's `logRef` lands on. veteran: it is the
              RAIL, not the row — a per-row anchor is a change to `LogsRail`,
              which this pass does not own; give the rail row ids and this href
              becomes `#log-<id>` with nothing else moving. */}
          <section id={LOGS_ANCHOR} className="rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
                correlated logs
              </h2>
              <span className="font-mono text-[10.5px] text-faint">
                {solidCount} on trace · {nearbyCount} nearby (same pods, ±{NEARBY_LOG_WINDOW_S}s)
                {nearbyTruncated ? ` · ${NEARBY_LOG_CAP} shown, more exist in this window` : ""}
              </span>
            </div>
            <div className="px-3 py-1">
              <LogsRail logs={trace.logs} />
            </div>
          </section>
        </div>

        <div className="min-w-0 space-y-4">
          {explainOpen && (
            <ExplainPanel
              traceId={trace.id}
              prepared={trace.explanation ?? answered ?? undefined}
              used={explain.used + runsSpent}
              quota={explain.quota}
              logsHref={`#${LOGS_ANCHOR}`}
              onSelectSpan={setSelectedId}
              onFinished={(run) => {
                if (costsARun(run)) setRunsSpent((n) => n + 1);
                if (run.phase === "answered") setAnswered(run.explanation);
              }}
              onClose={() => setExplainOpen(false)}
            />
          )}
          <section className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3 py-2">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
                span detail
              </h2>
            </div>
            <SpanDetail span={selected} />
          </section>
        </div>
      </div>
      )}

    </div>
  );
}
