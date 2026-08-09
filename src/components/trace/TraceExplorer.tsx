"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Link2, Sparkles, Check } from "lucide-react";
import { fmtCost, fmtMs, fmtTokens, timeAgo } from "@/lib/format";
import { layerColor } from "@/lib/layers";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Trace } from "@/mock/types";
import { Waterfall } from "./Waterfall";
import { SpanDetail } from "./SpanDetail";
import { LogsRail } from "./LogsRail";
import { ExplainPanel } from "./ExplainPanel";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className="font-mono text-[12px] text-ink">{value}</span>
    </span>
  );
}

export function TraceExplorer({ trace }: { trace: Trace }) {
  const firstError = useMemo(
    () => trace.spans.find((s) => s.status === "error"),
    [trace],
  );
  const [selectedId, setSelectedId] = useState<string>(
    (firstError ?? trace.spans[0]).id,
  );
  const [explainOpen, setExplainOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const selected = trace.spans.find((s) => s.id === selectedId) ?? trace.spans[0];
  const hasFailure = trace.status === "error" || trace.spans.some((s) => s.status === "error");
  const solidCount = trace.logs.filter((l) => l.traceId).length;

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
          <button
            type="button"
            onClick={copyLink}
            className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] text-mid hover:border-line-strong hover:text-ink"
          >
            {copied ? <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} /> : <Link2 className="h-3.5 w-3.5" />}
            {copied ? "copied" : "copy link"}
          </button>
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
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          <section className="rounded-lg border border-line bg-surface p-3">
            <Waterfall trace={trace} selectedId={selectedId} onSelect={setSelectedId} />
          </section>

          <section className="rounded-lg border border-line bg-surface">
            <div className="flex items-center justify-between border-b border-line px-3 py-2">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
                correlated logs
              </h2>
              <span className="font-mono text-[10.5px] text-faint">
                {solidCount} on trace · {trace.logs.length - solidCount} nearby (same pods, ±10s)
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
    </div>
  );
}
