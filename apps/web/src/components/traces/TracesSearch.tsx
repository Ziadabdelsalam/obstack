"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { fmtCost, fmtMs, fmtTokens, timeAgo } from "@/lib/format";
import { LayerDot } from "@/components/ui/LayerChip";
import { SavedViewsMenu } from "@/components/saved-views/SavedViewsMenu";
import {
  TRACE_RANGE_HOURS,
  TRACE_STATUSES,
  parseTracesUrl,
  pushedUrl,
  syncUrl,
  tracesHref,
  tracesSearchString,
  tracesViewFilters,
  type TracesFilters,
  type UrlSync,
} from "@/lib/traces-filter";
import type { Layer, Trace } from "@/lib/types";

const serviceLayer: Record<string, Layer> = {
  gateway: "api",
  "agent-worker": "agent",
  tools: "tool",
  "sync-worker": "infra",
};

/**
 * Cost bounds the bar offers. The ladder is the control's vocabulary, not the
 * filter's range: the URL contract takes any number, so a deep link or a saved
 * view carrying a bound off the ladder still filters — the select just has no
 * option to show for it.
 */
const COST_STEPS = [0.01, 0.1, 1] as const;

/**
 * The traces filter bar. Every control's value lives in the URL and matching
 * happens server-side through the facade — nothing here filters `traces`, which
 * would fork the matching rules per mode (D13).
 *
 * Two directions of flow, and both are the URL:
 * - an edit lands in `edited`, is serialized, and (debounced, so a typed word is
 *   one list query rather than one per keystroke) replaces the URL;
 * - a URL that moves underneath the bar — back/forward, a link into a filtered
 *   view, a saved view applied — is adopted into `edited` by `syncUrl`, so the
 *   inputs never keep mount-time values while the list shows something else.
 *
 * `service` and `model` are typed exactly rather than picked from a list: the
 * facade has no distinct-values entry point, and a hardcoded option list would
 * be the mock's vocabulary — buttons that reliably return nothing on real data,
 * which is why the shipped presets were dropped (D47(iv)).
 */
export function TracesSearch({
  traces,
  total,
  nowMs,
  pageCount,
  filters,
}: {
  traces: Trace[];
  total: number;
  /** the request's reference clock, per mode (D50/D64) — never sampled here */
  nowMs: number;
  pageCount: number;
  filters: TracesFilters;
}) {
  const router = useRouter();
  const urlSearch = tracesSearchString(filters);
  const [edited, setEdited] = useState<TracesFilters>(filters);
  const [sync, setSync] = useState<UrlSync>({ seen: urlSearch, pending: [] });

  // Adjusting state during render — React's own pattern for state derived from
  // a prop that changed. The URL is the prop here, and `syncUrl` decides whether
  // this one is the bar's own navigation coming back or someone else's.
  if (urlSearch !== sync.seen) {
    const next = syncUrl(sync, urlSearch);
    setSync(next.sync);
    if (next.adopt) setEdited(filters);
  }

  const editedSearch = tracesSearchString(edited);
  const settled = editedSearch === sync.seen || sync.pending.includes(editedSearch);

  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => {
      setSync((s) => pushedUrl(s, editedSearch));
      router.replace(tracesHref(editedSearch), { scroll: false });
    }, 250);
    return () => clearTimeout(timer);
  }, [settled, editedSearch, router]);

  // Any filter change is a new question, so it starts at the first page; the
  // pager is the only control that moves `page`.
  const update = (patch: Partial<TracesFilters>) =>
    setEdited((f) => ({ ...f, ...patch, page: 1 }));

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Traces</h1>
        {/* The APPLIED bound, not a fixed string and not the pending one: these
            rows and this total came from the URL's range (D50), so the label
            reads `filters`, which changes only when the list does. */}
        <span className="font-mono text-[11px] text-faint">
          last {filters.range} · {traces.length} of {total} traces
        </span>
      </div>

      {/* filter bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2" data-tour="traces">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            value={edited.q}
            onChange={(e) => update({ q: e.target.value })}
            placeholder="Search traces, spans, prompts, logs…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pr-3 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
        </div>
        <input
          value={edited.service}
          onChange={(e) => update({ service: e.target.value })}
          placeholder="service"
          aria-label="Service filter"
          className="w-[120px] rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
        />
        <input
          value={edited.model}
          onChange={(e) => update({ model: e.target.value })}
          placeholder="model"
          aria-label="Model filter"
          className="w-[120px] rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
        />
        <select
          value={edited.status}
          onChange={(e) => update({ status: e.target.value as TracesFilters["status"] })}
          aria-label="Status filter"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          {TRACE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {`status: ${s}`}
            </option>
          ))}
        </select>
        <select
          value={edited.minMs}
          onChange={(e) => update({ minMs: Number(e.target.value) })}
          aria-label="Duration filter"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value={0}>duration: any</option>
          <option value={1000}>&gt; 1s</option>
          <option value={5000}>&gt; 5s</option>
          <option value={10000}>&gt; 10s</option>
        </select>
        <select
          value={edited.minCost}
          onChange={(e) => update({ minCost: Number(e.target.value) })}
          aria-label="Minimum cost filter"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value={0}>cost: any</option>
          {COST_STEPS.map((c) => (
            <option key={c} value={c}>
              &gt; {fmtCost(c)}
            </option>
          ))}
        </select>
        <select
          value={edited.maxCost}
          onChange={(e) => update({ maxCost: Number(e.target.value) })}
          aria-label="Maximum cost filter"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value={-1}>max cost: none</option>
          {COST_STEPS.map((c) => (
            <option key={c} value={c}>
              ≤ {fmtCost(c)}
            </option>
          ))}
        </select>
        <select
          value={edited.range}
          onChange={(e) => update({ range: e.target.value as TracesFilters["range"] })}
          aria-label="Time range filter"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          {Object.keys(TRACE_RANGE_HOURS).map((r) => (
            <option key={r} value={r}>
              last {r}
            </option>
          ))}
        </select>
        {/* Views come from `lib/saved-views` and nowhere else: one filter set,
            replaced whole, back to the first page. */}
        <SavedViewsMenu
          surface="traces"
          filters={tracesViewFilters(edited)}
          onApply={(view) => setEdited(parseTracesUrl(view))}
        />
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
                  {timeAgo(t.startedAt, nowMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pages are links, not state: page N is addressable, shareable and
          rendered by the server from its URL alone (D44). They page `filters`,
          the set these rows came from — not a half-typed edit still in the
          bar, which is a list nobody is looking at yet. */}
      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between">
          <span className="font-mono text-[11px] text-faint">
            page {filters.page} of {pageCount}
          </span>
          <span className="flex items-center gap-1.5">
            <PageLink filters={filters} to={filters.page - 1} disabled={filters.page <= 1}>
              <ChevronLeft className="h-3.5 w-3.5" />
              prev
            </PageLink>
            <PageLink
              filters={filters}
              to={filters.page + 1}
              disabled={filters.page >= pageCount}
            >
              next
              <ChevronRight className="h-3.5 w-3.5" />
            </PageLink>
          </span>
        </div>
      )}
    </div>
  );
}

/** A pager step: a real link while there is a page to reach, plain text at the end. */
function PageLink({
  filters,
  to,
  disabled,
  children,
}: {
  filters: TracesFilters;
  to: number;
  disabled: boolean;
  children: ReactNode;
}) {
  const className = "flex items-center gap-1 rounded-md border border-line px-2.5 py-1.5 text-[12.5px]";
  if (disabled) {
    return <span className={`${className} text-faint opacity-50`}>{children}</span>;
  }
  return (
    <Link
      href={tracesHref(tracesSearchString({ ...filters, page: to }))}
      className={`${className} bg-surface text-mid hover:border-line-strong hover:text-ink`}
    >
      {children}
    </Link>
  );
}
