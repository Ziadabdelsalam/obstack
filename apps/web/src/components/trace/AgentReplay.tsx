"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { fmtMs } from "@/lib/format";
import { layerColor, layerLabel } from "@/lib/layers";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Span, Trace } from "@/lib/types";

/**
 * Conversation-style step-through of an agent run — the trace as a readable
 * transcript instead of a waterfall.
 */

function fmtOffset(ms: number): string {
  return `+${(ms / 1000).toFixed(2)}s`;
}

function PromptBlock({ label, text, defaultOpen }: { label: string; text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? text.length < 260);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mb-1 flex items-center gap-1 font-mono text-[9.5px] uppercase tracking-widest text-faint hover:text-mid"
      >
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        {label}
      </button>
      {open ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-2.5 font-mono text-[11.5px] leading-relaxed text-mid">
          {text || "(empty)"}
        </pre>
      ) : (
        <p className="truncate rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] text-faint">
          {text.slice(0, 120)}…
        </p>
      )}
    </div>
  );
}

function StepCard({ span, active, index }: { span: Span; active: boolean; index: number }) {
  const err = span.status === "error";
  const color = layerColor[span.layer];
  return (
    <div
      id={`replay-step-${index}`}
      className="relative rounded-lg border bg-surface p-3.5 transition-colors"
      style={{
        borderColor: active
          ? `color-mix(in srgb, ${color} 55%, var(--color-line))`
          : err
            ? "color-mix(in srgb, var(--color-err) 35%, var(--color-line))"
            : "var(--color-line)",
        boxShadow: active ? `0 0 0 1px color-mix(in srgb, ${color} 35%, transparent)` : undefined,
      }}
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span
          className="flex h-5 items-center rounded-[3px] px-1.5 font-mono text-[9.5px] tracking-wide"
          style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
        >
          {layerLabel[span.layer]}
        </span>
        <span className="font-mono text-[13px] font-medium text-ink">{span.name}</span>
        <StatusPill status={span.status} />
        <span className="ml-auto font-mono text-[10.5px] text-faint">
          {fmtOffset(span.startMs)} · {fmtMs(span.durationMs)}
          {span.pod ? ` · ${span.pod}` : ""}
        </span>
      </div>

      {span.statusMessage && (
        <p
          className="mt-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-snug"
          style={{
            color: err ? "var(--color-err)" : "var(--color-mid)",
            borderColor: err ? "color-mix(in srgb, var(--color-err) 35%, transparent)" : "var(--color-line)",
            background: err ? "color-mix(in srgb, var(--color-err) 8%, transparent)" : "var(--color-raised)",
          }}
        >
          {span.statusMessage}
        </p>
      )}

      {span.llm && (
        <>
          <p className="mt-2 font-mono text-[10.5px] text-faint">
            {span.llm.model} · {span.llm.inputTokens}→{span.llm.outputTokens} tok ·{" "}
            {span.llm.finishReason}
          </p>
          <PromptBlock label="prompt" text={span.llm.prompt} />
          <PromptBlock label="completion" text={span.llm.completion} defaultOpen />
        </>
      )}

      {!span.llm && Object.keys(span.attrs).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5">
          {Object.entries(span.attrs).map(([k, v]) => (
            <span key={k} className="font-mono text-[10.5px] text-faint">
              {k}=<span className="text-mid">{String(v)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentReplay({ trace }: { trace: Trace }) {
  const steps = useMemo(() => {
    const agent = trace.spans.find((s) => s.layer === "agent");
    if (!agent) return trace.spans;
    const inRun = trace.spans.filter((s) => s.id === agent.id || s.parentId === agent.id);
    return [...inRun].sort((a, b) => a.startMs - b.startMs);
  }, [trace]);

  const [current, setCurrent] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = document.getElementById(`replay-step-${current}`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        setCurrent((c) => Math.min(steps.length - 1, c + 1));
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        setCurrent((c) => Math.max(0, c - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [steps.length]);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[11px] text-faint">
          step {current + 1} of {steps.length} · ↑↓ or j/k to walk the run
        </p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            disabled={current === 0}
            aria-label="Previous step"
            className="rounded-md border border-line bg-raised p-1.5 text-mid hover:text-ink disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setCurrent((c) => Math.min(steps.length - 1, c + 1))}
            disabled={current === steps.length - 1}
            aria-label="Next step"
            className="rounded-md border border-line bg-raised p-1.5 text-mid hover:text-ink disabled:opacity-40"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div ref={containerRef} className="relative ml-2 space-y-3 border-l border-line-strong pl-5">
        {steps.map((s, i) => (
          <div key={s.id} className="relative">
            <button
              type="button"
              onClick={() => setCurrent(i)}
              aria-label={`Go to step ${i + 1}`}
              className="absolute top-4 -left-[27px] h-[11px] w-[11px] rounded-full border-2 border-bg"
              style={{
                background: i <= current ? layerColor[s.layer] : "var(--color-line-strong)",
              }}
            />
            <StepCard span={s} active={i === current} index={i} />
          </div>
        ))}
      </div>
    </div>
  );
}
