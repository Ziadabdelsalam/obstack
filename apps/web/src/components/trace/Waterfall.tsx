"use client";

import { layerColor } from "@/lib/layers";
import { fmtMs } from "@/lib/format";
import { infraTrackHeading } from "@/lib/infra-track";
import { LayerChip } from "@/components/ui/LayerChip";
import type { K8sEvent, Span, Trace } from "@/lib/types";
import { AlertCircle } from "lucide-react";

const eventColor: Record<K8sEvent["severity"], string> = {
  info: "var(--color-mid)",
  warn: "var(--color-warn)",
  fatal: "var(--color-err)",
};

interface PodTrack {
  pod: string;
  node?: string;
  /** activity window from this pod's spans, if any */
  window?: { start: number; end: number };
  events: K8sEvent[];
}

function buildPodTracks(trace: Trace): PodTrack[] {
  const tracks = new Map<string, PodTrack>();
  for (const s of trace.spans) {
    if (!s.pod) continue;
    const t = tracks.get(s.pod) ?? { pod: s.pod, node: s.node, events: [] };
    const end = s.startMs + s.durationMs;
    t.window = t.window
      ? { start: Math.min(t.window.start, s.startMs), end: Math.max(t.window.end, end) }
      : { start: s.startMs, end };
    tracks.set(s.pod, t);
  }
  for (const e of trace.k8sEvents ?? []) {
    const t = tracks.get(e.pod) ?? { pod: e.pod, events: [] };
    t.events.push(e);
    tracks.set(e.pod, t);
  }
  return [...tracks.values()];
}

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
  const podTracks = buildPodTracks(trace);
  const byId = new Map(trace.spans.map((s) => [s.id, s]));
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
            const parent = span.parentId ? byId.get(span.parentId) : undefined;
            const crossesService = parent !== undefined && parent.service !== span.service;
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
                  {crossesService && (
                    <span
                      className="shrink-0 truncate font-mono text-[9px] tracking-wide"
                      style={{ color: layerColor[span.layer] }}
                      title={`service boundary: ${parent.service} → ${span.service}`}
                    >
                      → {span.service}
                    </span>
                  )}
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

          {/* infra track — the pods this trace ran on, and any cluster events
              that landed on them. The heading earns its second half rather
              than asserting it: nothing in the live pipeline sets `k8sEvents`
              (`server/adapters.ts`), and half the demo's own stories carry
              none, so the unconditional wording named a data type the timeline
              below it did not contain (F2). */}
          {podTracks.length > 0 && (
            <>
              <div className="mt-1 flex items-center border-t border-line pt-1.5 pb-0.5">
                <span
                  className="pl-2 font-mono text-[9.5px] uppercase tracking-widest"
                  style={{ color: "var(--color-infra)" }}
                >
                  {infraTrackHeading(podTracks)}
                </span>
              </div>
              {podTracks.map((t) => (
                <div key={t.pod} className="relative flex w-full items-center py-[3px]">
                  <div className="flex w-[252px] shrink-0 items-center gap-1.5 overflow-hidden pr-2 pl-2">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: "var(--color-infra)" }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[10.5px] text-mid">
                        {t.pod}
                      </span>
                      {t.node && (
                        <span className="block truncate font-mono text-[9px] text-faint">
                          {t.node}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="relative h-[22px] flex-1">
                    {t.window && (
                      <span
                        className="absolute top-1/2 h-[5px] -translate-y-1/2 rounded-[2px]"
                        style={{
                          left: `${Math.max((t.window.start / total) * 100, 0)}%`,
                          width: `${Math.max(((t.window.end - t.window.start) / total) * 100, 0.6)}%`,
                          background: "color-mix(in srgb, var(--color-infra) 35%, transparent)",
                          boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--color-infra) 55%, transparent)",
                        }}
                      />
                    )}
                    {t.events.map((e) => {
                      const clamped = Math.min(Math.max(e.atMs, 0), total);
                      const before = e.atMs < 0;
                      return (
                        <span
                          key={e.id}
                          title={`${before ? `${(e.atMs / 1000).toFixed(1)}s before trace · ` : ""}${e.label}`}
                          className="absolute top-1/2 z-10 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rotate-45 cursor-help"
                          style={{
                            left: `${(clamped / total) * 100}%`,
                            background: eventColor[e.severity],
                            boxShadow: "0 0 0 2px var(--color-surface)",
                            opacity: before ? 0.75 : 1,
                          }}
                        />
                      );
                    })}
                  </div>
                  <div className="w-[72px] shrink-0 pr-2 text-right font-mono text-[9.5px] text-faint">
                    {t.events.length > 0
                      ? t.events.map((e) => e.kind.replace("_", " ")).join(" · ")
                      : ""}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
