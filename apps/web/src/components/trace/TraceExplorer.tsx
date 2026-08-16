"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Link2, Sparkles, Check, GitCompareArrows, Share2, X, Copy } from "lucide-react";
import { fmtCost, fmtMs, fmtTokens, timeAgo } from "@/lib/format";
import { layerColor } from "@/lib/layers";
import { NEARBY_LOG_CAP, NEARBY_LOG_WINDOW_S } from "@/lib/nearby-logs";
import { StatusPill } from "@/components/ui/StatusPill";
import { allTraces } from "@/mock/traces";
import type { Trace } from "@/lib/types";
import { Waterfall } from "./Waterfall";
import { SpanDetail } from "./SpanDetail";
import { LogsRail } from "./LogsRail";
import { ExplainPanel } from "./ExplainPanel";
import { AgentReplay } from "./AgentReplay";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className="font-mono text-[12px] text-ink">{value}</span>
    </span>
  );
}

/**
 * `compareEnabled` is false in live mode (F8): the healthy-run comparison picks
 * its counterpart out of the mock corpus, so on an ingested trace it would offer
 * a diff against a run that never happened. Defaults to true — mock mode and the
 * diff surface are unchanged.
 */
export function TraceExplorer({
  trace,
  compareEnabled = true,
}: {
  trace: Trace;
  compareEnabled?: boolean;
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
  const [shareOpen, setShareOpen] = useState(false);
  const [shareEnabled, setShareEnabled] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [view, setView] = useState<"waterfall" | "replay">("waterfall");
  const hasAgent = trace.spans.some((s) => s.layer === "agent");

  const compareWith = useMemo(
    () =>
      compareEnabled
        ? allTraces.find(
            (t) => t.rootName === trace.rootName && t.status === "ok" && t.id !== trace.id,
          )
        : undefined,
    [trace, compareEnabled],
  );
  const shareUrl = `https://obstack.dev/share/tr_${trace.id.slice(0, 10)}`;

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
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] text-mid hover:border-line-strong hover:text-ink"
          >
            <Share2 className="h-3.5 w-3.5" />
            share
          </button>
          {compareWith && (
            <Link
              href={`/app/traces/diff?a=${trace.id}&b=${compareWith.id}`}
              className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] text-mid hover:border-line-strong hover:text-ink"
            >
              <GitCompareArrows className="h-3.5 w-3.5" />
              diff vs healthy run
            </Link>
          )}
          {hasFailure && trace.explanation && (
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
        <Stat label="started" value={timeAgo(trace.startedAt)} />
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

          <section className="rounded-lg border border-line bg-surface">
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
          {explainOpen && trace.explanation && (
            <ExplainPanel
              explanation={trace.explanation}
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

      {/* share modal */}
      {shareOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setShareOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Share trace"
        >
          <div
            className="w-full max-w-md rounded-xl border border-line-strong bg-surface p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold text-ink">Share this trace</h3>
              <button type="button" onClick={() => setShareOpen(false)} aria-label="Close" className="rounded p-1 text-faint hover:bg-overlay hover:text-ink">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 flex items-center justify-between rounded-md border border-line bg-raised px-3 py-2.5">
              <span className="text-[13px] text-mid">Public link</span>
              <button
                type="button"
                onClick={() => setShareEnabled((v) => !v)}
                aria-pressed={shareEnabled}
                className="h-4 w-7 rounded-full p-px transition-colors"
                style={{ background: shareEnabled ? "color-mix(in srgb, var(--color-ok) 50%, var(--color-line))" : "var(--color-line)" }}
              >
                <span className="block h-3.5 w-3.5 rounded-full bg-ink transition-transform" style={{ transform: shareEnabled ? "translateX(12px)" : "none" }} />
              </button>
            </div>
            {shareEnabled ? (
              <>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded-md border border-line bg-bg px-2.5 py-2 font-mono text-[11.5px] text-ink">
                    {shareUrl}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard.writeText(shareUrl).catch(() => {});
                      setShareCopied(true);
                      setTimeout(() => setShareCopied(false), 1500);
                    }}
                    aria-label="Copy share link"
                    className="rounded-md border border-line bg-raised p-2 text-mid hover:text-ink"
                  >
                    {shareCopied ? <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-faint">
                  read-only · prompts and completions redacted by default · expires in 7 days
                </p>
              </>
            ) : (
              <p className="mt-3 text-[12.5px] leading-relaxed text-mid">
                Anyone with the link can view this trace read-only — no workspace access, prompts
                redacted unless you opt in.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
