"use client";

import { layerColor } from "@/lib/layers";
import { fmtMs } from "@/lib/format";
import { LayerChip } from "@/components/ui/LayerChip";
import type { Span, Trace } from "@/mock/types";
import { AlertCircle } from "lucide-react";

interface Row {
  span: Span;
  depth: number;
}

function buildRows(trace: Trace): Row[] {
  const children = new Map<string | null, Span[]>();
  for (const s of trace.spans) {
    const list = children.get(s.parentId) ?? [];
    list.push(s);
    children.set(s.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.startMs - b.startMs);
  const rows: Row[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const s of children.get(parentId) ?? []) {
      rows.push({ span: s, depth });
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function Waterfall({
  trace,
  selectedId,
  onSelect,
  animate = false,
}: {
  trace: Trace;
  selectedId: string | null;
  onSelect: (id: string) => void;
  animate?: boolean;
}) {
  const rows = buildRows(trace);
  const total = trace.durationMs;
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        {/* time axis */}
        <div className="flex border-b border-line pb-1 text-[10px] font-mono text-faint">
          <div className="w-[252px] shrink-0 pl-2">span</div>
          <div className="relative h-4 flex-1">
            {ticks.map((f) => (
              <span
                key={f}
                className="absolute -translate-x-1/2"
                style={{ left: `${f * 100}%` }}
              >
                {fmtMs(total * f)}
              </span>
            ))}
          </div>
          <div className="w-[72px] shrink-0" />
        </div>

        <div className="relative">
          {/* gridlines */}
          <div className="pointer-events-none absolute inset-0 flex">
            <div className="w-[252px] shrink-0" />
            <div className="relative flex-1">
              {ticks.slice(1).map((f) => (
                <span
                  key={f}
                  className="absolute top-0 bottom-0 w-px bg-line/60"
                  style={{ left: `${f * 100}%` }}
                />
              ))}
            </div>
            <div className="w-[72px] shrink-0" />
          </div>

          {rows.map(({ span, depth }, i) => {
            const isSel = span.id === selectedId;
            const err = span.status === "error";
            const left = (span.startMs / total) * 100;
            const width = Math.max((span.durationMs / total) * 100, 0.6);
            return (
              <button
                key={span.id}
                type="button"
                onClick={() => onSelect(span.id)}
                className={`group relative flex w-full items-center py-[3px] text-left transition-colors ${
                  isSel ? "bg-overlay" : "hover:bg-raised"
                }`}
              >
                <div
                  className="flex w-[252px] shrink-0 items-center gap-1.5 overflow-hidden pr-2"
                  style={{ paddingLeft: 8 + depth * 14 }}
                >
                  {err && (
                    <AlertCircle className="h-3 w-3 shrink-0" style={{ color: "var(--color-err)" }} />
                  )}
                  <span
                    className={`truncate font-mono text-[11.5px] ${
                      isSel ? "text-ink" : err ? "text-ink" : "text-mid group-hover:text-ink"
                    }`}
                  >
                    {span.name}
                  </span>
                  <LayerChip layer={span.layer} />
                </div>
                <div className="relative h-[18px] flex-1">
                  <span
                    className={`absolute top-1/2 h-[8px] -translate-y-1/2 rounded-[2px] ${animate ? "span-in" : ""}`}
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: err
                        ? `color-mix(in srgb, ${layerColor[span.layer]} 55%, var(--color-err))`
                        : layerColor[span.layer],
                      boxShadow: err ? "0 0 0 1px var(--color-err)" : undefined,
                      animationDelay: animate ? `${i * 90}ms` : undefined,
                    }}
                  />
                </div>
                <div
                  className="w-[72px] shrink-0 pr-2 text-right font-mono text-[11px]"
                  style={{ color: err ? "var(--color-err)" : "var(--color-mid)" }}
                >
                  {fmtMs(span.durationMs)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
