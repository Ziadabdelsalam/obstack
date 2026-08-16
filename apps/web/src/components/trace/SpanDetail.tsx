"use client";

import { fmtCost, fmtMs, fmtTokens } from "@/lib/format";
import { LayerChip } from "@/components/ui/LayerChip";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Span } from "@/lib/types";

function KV({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line/60 py-1 last:border-0">
      <span className="font-mono text-[11px] text-faint">{k}</span>
      <span className="truncate text-right font-mono text-[11px] text-mid">{v}</span>
    </div>
  );
}

function PromptBlock({ label, text, truncated }: { label: string; text: string; truncated?: boolean }) {
  return (
    <div className="mt-3">
      <p className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-faint">
        {label}
        {truncated && (
          <span
            className="rounded-[3px] px-1 py-px text-[9px] tracking-wide"
            style={{
              color: "var(--color-err)",
              background: "color-mix(in srgb, var(--color-err) 12%, transparent)",
            }}
          >
            TRUNCATED
          </span>
        )}
      </p>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-line bg-bg p-2.5 font-mono text-[11px] leading-relaxed text-mid">
        {text || "(empty)"}
      </pre>
    </div>
  );
}

export function SpanDetail({ span }: { span: Span }) {
  return (
    <div className="p-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 truncate font-mono text-[13px] text-ink">{span.name}</h3>
        <LayerChip layer={span.layer} />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <StatusPill status={span.status} />
        <span className="font-mono text-[11px] text-faint">{span.service}</span>
        <span className="font-mono text-[11px] text-mid">{fmtMs(span.durationMs)}</span>
      </div>
      {span.pod && (
        <p className="mt-1.5 flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-infra)" }} />
          {span.pod}
          {span.node && <span className="text-faint/70">· {span.node}</span>}
        </p>
      )}
      {span.statusMessage && (
        <p
          className="mt-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-snug"
          style={{
            color: span.status === "error" ? "var(--color-err)" : "var(--color-mid)",
            borderColor:
              span.status === "error"
                ? "color-mix(in srgb, var(--color-err) 35%, transparent)"
                : "var(--color-line)",
            background:
              span.status === "error"
                ? "color-mix(in srgb, var(--color-err) 8%, transparent)"
                : "var(--color-raised)",
          }}
        >
          {span.statusMessage}
        </p>
      )}

      {span.llm && (
        <div className="mt-3 rounded-md border border-line bg-raised p-2.5">
          <div className="grid grid-cols-2 gap-x-4">
            <KV k="model" v={span.llm.model} />
            <KV k="finish" v={span.llm.finishReason} />
            <KV k="tokens.in" v={fmtTokens(span.llm.inputTokens)} />
            <KV k="tokens.out" v={fmtTokens(span.llm.outputTokens)} />
            <KV k="cost" v={fmtCost(span.llm.costUsd)} />
            <KV k="latency" v={fmtMs(span.durationMs)} />
          </div>
          <PromptBlock label="prompt" text={span.llm.prompt} />
          <PromptBlock
            label="completion"
            text={span.llm.completion}
            truncated={span.llm.finishReason === "truncated"}
          />
        </div>
      )}

      {Object.keys(span.attrs).length > 0 && (
        <div className="mt-3">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-faint">
            attributes
          </p>
          <div className="rounded-md border border-line bg-raised px-2.5 py-1">
            {Object.entries(span.attrs).map(([k, v]) => (
              <KV key={k} k={k} v={v} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
