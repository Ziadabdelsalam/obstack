"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, RefreshCw, Search } from "lucide-react";
import { SavedViewsMenu } from "@/components/saved-views/SavedViewsMenu";
// The surface's URL contract — parameter names, defaults, serialization —
// shared with the server page so this bar cannot disagree with the parse on the
// other side of the round trip (D65).
import {
  LOG_RANGE_HOURS,
  SEVERITY_ORDER,
  DEFAULT_LOG_SEVERITY,
  logsHref,
  logsSearchString,
  logsViewFilters,
  type LogRange,
  type LogsFilters,
} from "@/lib/logs-filter";
import type { SavedViewFilters } from "@/lib/saved-views";
import type { Severity } from "@/lib/types";
// Type-only, so nothing from the server graph is emitted into the client
// bundle: the D13 facade rule says this surface knows `@/server/data` and
// nothing below it — never `@/server/queries/*`, never `@/mock/*` (D51(d)).
import type { LogLine } from "@/server/data";

/**
 * The severity floors the bar offers: every rank except the strongest, because
 * a "fatal+" floor is a filter nobody reaches for and the weakest one is how
 * the control says "no floor". Labels are derived, so the vocabulary has one
 * definition (D65) — this dropdown cannot offer a value the parser rejects.
 */
const SEVERITY_CHOICES = SEVERITY_ORDER.slice(0, -1).map((sev) => ({
  value: sev,
  label: sev === DEFAULT_LOG_SEVERITY ? "severity: all" : `${sev}+`,
}));

const RANGE_CHOICES = Object.keys(LOG_RANGE_HOURS) as LogRange[];

const sevColor: Record<Severity, string> = {
  debug: "var(--color-faint)",
  info: "var(--color-mid)",
  warn: "var(--color-warn)",
  error: "var(--color-err)",
  fatal: "var(--color-err)",
};

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

/**
 * Ages are measured against the clock the query bound its window to (D48/D50) —
 * the request's server time in live mode, the mock clock in mock mode — so a
 * row can never read "3h" inside a window the header calls "last 1h".
 */
function ago(nowMs: number, ts: number): string {
  const m = Math.floor((nowMs - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

/**
 * The logs explorer. Nothing here filters `logs` — matching happens server-side
 * through the facade under one contract per mode (D13); every control change
 * lands in the URL and the page re-reads the table.
 *
 * The `applied*` props are what the server actually queried; `filters` is what
 * the controls currently hold. The header reports the applied values only — a
 * count of what rendered, the query's real bound and the truncation marker
 * (D48/D13/D21). Nothing tails anything: refreshing is a button.
 */
export function LogsExplorer({
  logs,
  pods,
  truncated,
  nowMs,
  q: appliedQ,
  sev: appliedSev,
  pod: appliedPod,
  onTrace: appliedOnTrace,
  range: appliedRange,
}: {
  logs: LogLine[];
  /** pod options from the same data the rows came from, never a mock list */
  pods: string[];
  /** proven by the cap+1 fetch — more rows match than the surface renders */
  truncated: boolean;
  nowMs: number;
} & LogsFilters) {
  const router = useRouter();
  const [filters, setFilters] = useState<LogsFilters>({
    q: appliedQ,
    sev: appliedSev,
    pod: appliedPod,
    onTrace: appliedOnTrace,
    range: appliedRange,
  });

  // What the server already rendered; the sync below is a no-op until it moves.
  const pushed = useRef(
    logsSearchString({
      q: appliedQ,
      sev: appliedSev,
      pod: appliedPod,
      onTrace: appliedOnTrace,
      range: appliedRange,
    }),
  );

  useEffect(() => {
    const search = logsSearchString(filters);
    if (search === pushed.current) return;
    // Debounced so a typed word is one log query, not one per keystroke.
    const timer = setTimeout(() => {
      pushed.current = search;
      router.replace(logsHref(search), { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [filters, router]);

  // The other direction: the URL moved underneath the bar — back/forward, a
  // link into a filtered view, or the saved view applied below — so the
  // controls adopt what the server rendered instead of keeping mount-time
  // values. Only a URL this component did not push counts as a move.
  useEffect(() => {
    const applied = {
      q: appliedQ,
      sev: appliedSev,
      pod: appliedPod,
      onTrace: appliedOnTrace,
      range: appliedRange,
    };
    const search = logsSearchString(applied);
    if (search === pushed.current) return;
    pushed.current = search;
    setFilters(applied);
  }, [appliedQ, appliedSev, appliedPod, appliedOnTrace, appliedRange]);

  /**
   * A view carries the surface's WHOLE filter set, so applying one REPLACES the
   * state rather than patching it (D47(ii)): it sets the URL and the sync above
   * adopts the server's parse of it — one state, one parser, never two.
   * `pushed` is deliberately left alone so that adoption fires.
   */
  const applyView = (view: SavedViewFilters) => {
    router.replace(logsHref(new URLSearchParams(view).toString()), { scroll: false });
  };

  const set = (patch: Partial<LogsFilters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Logs</h1>
        <span className="flex items-center gap-2 font-mono text-[11px] text-faint">
          {logs.length} shown{truncated && " · more match"} · last {appliedRange}
          <button
            type="button"
            onClick={() => router.refresh()}
            aria-label="Refresh logs"
            className="rounded-md border border-line bg-surface p-1 text-mid hover:border-line-strong hover:text-ink"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search log bodies…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pr-3 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
        </div>
        <select
          value={filters.sev}
          onChange={(e) => set({ sev: e.target.value as Severity })}
          aria-label="Minimum severity"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          {SEVERITY_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
        <select
          value={filters.pod}
          onChange={(e) => set({ pod: e.target.value })}
          aria-label="Pod filter"
          className="max-w-[220px] rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value="">pod: all</option>
          {pods.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select
          value={filters.range}
          onChange={(e) => set({ range: e.target.value as LogRange })}
          aria-label="Time range"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          {RANGE_CHOICES.map((range) => (
            <option key={range} value={range}>
              last {range}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => set({ onTrace: !filters.onTrace })}
          className="rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition-colors"
          style={{
            borderColor: filters.onTrace
              ? "color-mix(in srgb, var(--color-infra) 45%, var(--color-line))"
              : "var(--color-line)",
            color: filters.onTrace ? "var(--color-infra)" : "var(--color-mid)",
            background: filters.onTrace
              ? "color-mix(in srgb, var(--color-infra) 8%, transparent)"
              : "var(--color-surface)",
          }}
        >
          on-trace only
        </button>
        <SavedViewsMenu
          surface="logs"
          filters={logsViewFilters(filters)}
          onApply={applyView}
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface" data-tour="logs">
        <table className="w-full min-w-[860px] border-collapse">
          <tbody>
            {logs.length === 0 && (
              <tr>
                <td className="px-3 py-10 text-center text-[13px] text-faint">
                  No log lines match. Loosen a filter or clear the search.
                </td>
              </tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} className="group border-b border-line/40 last:border-0 hover:bg-raised">
                <td className="w-[74px] py-[5px] pl-3 align-top font-mono text-[10.5px] text-faint">
                  {clock(l.ts)}
                </td>
                <td className="w-[46px] py-[5px] align-top">
                  <span
                    className="font-mono text-[10px] font-medium uppercase"
                    style={{ color: sevColor[l.severity], fontWeight: l.severity === "fatal" ? 700 : 500 }}
                  >
                    {l.severity}
                  </span>
                </td>
                <td className="py-[5px] pr-3 align-top font-mono text-[11.5px] leading-relaxed text-mid group-hover:text-ink">
                  {l.body}
                </td>
                <td className="w-[200px] py-[5px] pr-2 text-right align-top font-mono text-[10px] text-faint">
                  {l.pod}
                </td>
                <td className="w-[48px] py-[5px] pr-1 text-right align-top font-mono text-[10px] text-faint">
                  {ago(nowMs, l.ts)}
                </td>
                <td className="w-[70px] py-[5px] pr-3 text-right align-top">
                  {l.traceId ? (
                    <Link
                      href={`/app/traces/${l.traceId}`}
                      className="inline-flex items-center gap-0.5 font-mono text-[9.5px] tracking-wide hover:underline"
                      style={{ color: "var(--color-infra)" }}
                    >
                      TRACE <ArrowUpRight className="h-2.5 w-2.5" />
                    </Link>
                  ) : (
                    <span className="font-mono text-[9.5px] text-faint/60">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
