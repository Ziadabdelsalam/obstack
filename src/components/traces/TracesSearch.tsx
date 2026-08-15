"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Search, Bookmark, ChevronDown } from "lucide-react";
import { fmtCost, fmtMs, fmtTokens, timeAgo } from "@/lib/format";
import { LayerDot } from "@/components/ui/LayerChip";
import type { Layer, Trace } from "@/lib/types";

const savedViews = [
  { name: "Errors only", q: "", status: "error", minMs: 0 },
  { name: "Slow agent runs (>5s)", q: "agent", status: "all", minMs: 5000 },
  { name: "High cost (>$0.02)", q: "", status: "all", minMs: 0, minCost: 0.02 },
] as const;

const serviceLayer: Record<string, Layer> = {
  gateway: "api",
  "agent-worker": "agent",
  tools: "tool",
  "sync-worker": "infra",
};

interface Filters {
  q: string;
  status: string;
  minMs: number;
  minCost: number;
}

function toSearch({ q, status, minMs, minCost }: Filters): string {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (status !== "all") p.set("status", status);
  if (minMs > 0) p.set("minMs", String(minMs));
  if (minCost > 0) p.set("minCost", String(minCost));
  return p.toString();
}

/**
 * The filter bar owns its inputs, but matching happens server-side through the
 * facade: every change lands in the URL and the page re-reads the list. Nothing
 * here filters `traces` — that would fork the matching rules per mode.
 */
export function TracesSearch({
  traces,
  total,
  q: initialQ,
  status: initialStatus,
  minMs: initialMinMs,
  minCost: initialMinCost,
}: {
  traces: Trace[];
  total: number;
} & Filters) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ);
  const [status, setStatus] = useState<string>(initialStatus);
  const [minMs, setMinMs] = useState<number>(initialMinMs);
  const [minCost, setMinCost] = useState<number>(initialMinCost);
  const [viewsOpen, setViewsOpen] = useState(false);

  // What the server already rendered; the sync below is a no-op until it moves.
  const pushed = useRef(
    toSearch({
      q: initialQ,
      status: initialStatus,
      minMs: initialMinMs,
      minCost: initialMinCost,
    }),
  );

  useEffect(() => {
    const search = toSearch({ q, status, minMs, minCost });
    if (search === pushed.current) return;
    // Debounced so a typed word is one list query, not one per keystroke.
    const timer = setTimeout(() => {
      pushed.current = search;
      router.replace(search ? `/app/traces?${search}` : "/app/traces", {
        scroll: false,
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, status, minMs, minCost, router]);

  const applyView = (v: (typeof savedViews)[number]) => {
    setQ(v.q);
    setStatus(v.status);
    setMinMs(v.minMs);
    setMinCost("minCost" in v ? (v.minCost as number) : 0);
    setViewsOpen(false);
  };

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Traces</h1>
        <span className="font-mono text-[11px] text-faint">
          last 6h · {traces.length} of {total} traces
        </span>
      </div>

      {/* filter bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2" data-tour="traces">
        <div className="relative min-w-[260px] flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search traces, spans, prompts, logs…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pr-3 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status filter"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value="all">status: all</option>
          <option value="ok">status: ok</option>
          <option value="error">status: error</option>
        </select>
        <select
          value={minMs}
          onChange={(e) => setMinMs(Number(e.target.value))}
          aria-label="Duration filter"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value={0}>duration: any</option>
          <option value={1000}>&gt; 1s</option>
          <option value={5000}>&gt; 5s</option>
          <option value={10000}>&gt; 10s</option>
        </select>
        <div className="relative">
          <button
            type="button"
            onClick={() => setViewsOpen((o) => !o)}
            className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink"
          >
            <Bookmark className="h-3.5 w-3.5" />
            saved views
            <ChevronDown className="h-3 w-3" />
          </button>
          {viewsOpen && (
            <div className="absolute right-0 z-10 mt-1 w-56 rounded-md border border-line bg-overlay py-1 shadow-xl">
              {savedViews.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => applyView(v)}
                  className="block w-full px-3 py-1.5 text-left text-[12.5px] text-mid hover:bg-raised hover:text-ink"
                >
                  {v.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* results */}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[820px] border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
              <th className="py-2 pl-3 font-medium">trace</th>
              <th className="py-2 font-medium">layers</th>
              <th className="py-2 text-right font-medium">duration</th>
              <th className="py-2 text-right font-medium">tokens</th>
              <th className="py-2 text-right font-medium">cost</th>
              <th className="py-2 pl-4 font-medium">model</th>
              <th className="py-2 pr-3 text-right font-medium">age</th>
            </tr>
          </thead>
          <tbody>
            {traces.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-[13px] text-faint">
                  No traces match these filters. Clear a filter or widen the time range.
                </td>
              </tr>
            )}
            {traces.map((t) => (
              <tr key={t.id} className="group border-b border-line/50 last:border-0 hover:bg-raised">
                <td className="py-0 pl-3">
                  <Link href={`/app/traces/${t.id}`} className="flex items-center gap-2.5 py-2">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background: t.status === "ok" ? "var(--color-ok)" : "var(--color-err)",
                      }}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[12px] text-ink">
                        {t.rootName}
                      </span>
                      <span className="block font-mono text-[10px] text-faint">{t.id}</span>
                    </span>
                  </Link>
                </td>
                <td className="py-2">
                  <span className="flex items-center gap-1">
                    {t.services.map((s) => (
                      <LayerDot key={s} layer={serviceLayer[s] ?? "infra"} />
                    ))}
                    {t.models.length > 0 && <LayerDot layer="llm" />}
                  </span>
                </td>
                <td
                  className="py-2 text-right font-mono text-[11.5px]"
                  style={{
                    color: t.durationMs > 5000 ? "var(--color-warn)" : "var(--color-mid)",
                  }}
                >
                  {fmtMs(t.durationMs)}
                </td>
                <td className="py-2 text-right font-mono text-[11.5px] text-mid">
                  {t.totalTokens ? fmtTokens(t.totalTokens) : "—"}
                </td>
                <td className="py-2 text-right font-mono text-[11.5px] text-mid">
                  {fmtCost(t.costUsd)}
                </td>
                <td className="py-2 pl-4 font-mono text-[11px] text-faint">
                  {t.models.length ? t.models[t.models.length - 1] : "—"}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-[11px] text-faint">
                  {timeAgo(t.startedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
