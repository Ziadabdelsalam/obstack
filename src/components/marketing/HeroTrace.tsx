"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Waterfall } from "@/components/trace/Waterfall";
import { oomTrace } from "@/mock/stories";

const heroLogs = [
  { at: "+3.10s", sev: "warn", body: "memory pressure: rss 498MiB / limit 512Mi", solid: false },
  {
    at: "+4.21s",
    sev: "fatal",
    body: 'OOMKilled: container "app" exceeded memory limit (512Mi)',
    solid: false,
  },
  { at: "+4.23s", sev: "error", body: "draft_reply: stream aborted — connection reset by peer", solid: true },
];

export function HeroTrace() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl">
      {/* window chrome */}
      <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-overlay" />
          <span className="h-2.5 w-2.5 rounded-full bg-overlay" />
          <span className="h-2.5 w-2.5 rounded-full bg-overlay" />
        </span>
        <span className="ml-2 font-mono text-[11px] text-faint">
          obstack · trace {oomTrace.id}
        </span>
        <span
          className="ml-auto flex items-center gap-1.5 rounded-[3px] px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            color: "var(--color-err)",
            background: "color-mix(in srgb, var(--color-err) 12%, transparent)",
          }}
        >
          ● 502 · POST /v1/tickets/{"{id}"}/reply
        </span>
      </div>

      <div className="p-3">
        <Waterfall
          trace={oomTrace}
          selectedId={selected}
          onSelect={setSelected}
          animate
        />
      </div>

      {/* correlated logs strip */}
      <div className="border-t border-line px-4 py-2.5">
        <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-widest text-faint">
          correlated logs · agent-worker-7d9fb-kx2rq
        </p>
        {heroLogs.map((l) => (
          <p key={l.at} className="flex items-baseline gap-2.5 py-[3px] font-mono text-[11px]">
            <span className="text-faint">{l.at}</span>
            <span
              className="uppercase"
              style={{ color: l.sev === "warn" ? "var(--color-warn)" : "var(--color-err)" }}
            >
              {l.sev}
            </span>
            <span
              className="truncate border-l-2 pl-2 text-mid"
              style={{
                borderColor: l.solid
                  ? "var(--color-infra)"
                  : "color-mix(in srgb, var(--color-infra) 30%, transparent)",
                borderLeftStyle: l.solid ? "solid" : "dashed",
              }}
            >
              {l.body}
            </span>
          </p>
        ))}
      </div>

      {/* explain teaser */}
      <div
        className="flex items-center gap-2.5 border-t px-4 py-3"
        style={{
          borderColor: "color-mix(in srgb, var(--color-llm) 30%, var(--color-line))",
          background: "color-mix(in srgb, var(--color-llm) 5%, transparent)",
        }}
      >
        <Sparkles className="h-4 w-4 shrink-0" style={{ color: "var(--color-llm)" }} />
        <p className="truncate text-[12.5px] text-mid">
          <span className="font-medium text-ink">Explain:</span> pod OOM-kill truncated the
        completion mid-stream — the 502 started three layers below it.
        </p>
      </div>
    </div>
  );
}
