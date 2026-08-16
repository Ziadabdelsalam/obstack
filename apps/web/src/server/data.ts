import "server-only";
import type { Trace } from "@/lib/types";
import { NOW } from "@/mock/generate";
import { streamLogs } from "@/mock/logstream";
import { statCards, timeseries } from "@/mock/metrics";
import { allTraces, getTrace as getMockTrace } from "@/mock/traces";
import { DEFAULT_LOG_SEVERITY, SEVERITY_ORDER } from "@/lib/logs-filter";
import {
  DEFAULT_LOG_RANGE_MS,
  capLogRows,
  queryLogSearch,
  type LogFilter,
  type LogLine,
  type LogSearchResult,
} from "@/server/queries/logs";
import {
  queryOverview,
  type Overview,
  type OverviewRange,
} from "@/server/queries/overview";
import {
  DEFAULT_TRACE_RANGE_MS,
  TRACE_PAGE_SIZE,
  queryTrace,
  queryTraceSearch,
  splitSearchTerms,
  type TraceFilter,
  type TraceSearchResult,
} from "@/server/queries/traces";

export type {
  Overview,
  OverviewPoint,
  OverviewRange,
  OverviewStat,
} from "@/server/queries/overview";
export type { TraceFilter, TraceSearchResult } from "@/server/queries/traces";
export { DEFAULT_TRACE_RANGE_MS, TRACE_PAGE_SIZE } from "@/server/queries/traces";
export type { LogFilter, LogLine, LogSearchResult } from "@/server/queries/logs";
export { DEFAULT_LOG_RANGE_MS, LOG_SEARCH_CAP } from "@/server/queries/logs";
// The logs URL vocabulary is NOT re-exported: it lives in `@/lib/logs-filter`
// (D65), which the page and the bar import directly — a facade passthrough
// would put a second import path on a client-safe module for no reason.

/** The workspace every live query binds to — surfaced so pages can label it (F6). */
export { workspaceId } from "@/server/clickhouse";

export type DataMode = "live" | "mock";

function resolveMode(): DataMode {
  const raw = process.env.OBSTACK_DATA_MODE ?? "mock";
  if (raw !== "live" && raw !== "mock") {
    throw new Error(`OBSTACK_DATA_MODE must be "live" or "mock", got "${raw}"`);
  }
  if (raw === "live" && !process.env.CLICKHOUSE_URL) {
    throw new Error("OBSTACK_DATA_MODE=live requires CLICKHOUSE_URL");
  }
  return raw;
}

/**
 * The one switch between the ingested pipeline and the mock product (D13).
 * Pages import this facade and nothing below it — never `@/mock/traces` and
 * never `@/server/queries/*`.
 *
 * In live mode an empty result is an empty result: surfaces render their empty
 * state and never fall back to mock data, because a silent fallback would hide
 * a broken pipeline.
 */
export const dataMode: DataMode = resolveMode();

// Which routes render live data is a presentation concern shared with client
// components, so the D21 registry lives in `@/lib/live-routes`, not here.

/**
 * Mock free text — the mock half of the search contract (`search-contract.md`;
 * live half: `queries/traces.ts`). Reach in view-model terms: summary fields ∪
 * span names ∪ `llm.prompt`/`llm.completion` ∪ trace-carrying log bodies —
 * nearby rows (no `traceId`) are OUT, exactly as live's `trace_id != ''` leg.
 * Terms AND; each is a case-insensitive substring over any one field. Terms
 * are whitespace-split, so no term can span the `join(" ")` field boundary.
 * Exported for the parity tests, which assert this and the live SQL return the
 * same verdicts over an equivalent fixture.
 */
export function mockMatches(trace: Trace, q: string): boolean {
  const terms = splitSearchTerms(q);
  if (terms.length === 0) return true;
  const hay = [
    trace.rootName,
    trace.id,
    ...trace.models,
    ...trace.services,
    ...trace.spans.map((s) => s.name),
    ...trace.spans.map((s) => s.llm?.prompt ?? ""),
    ...trace.spans.map((s) => s.llm?.completion ?? ""),
    ...trace.logs.filter((l) => l.traceId).map((l) => l.body),
  ]
    .join(" ")
    .toLowerCase();
  return terms.every((term) => hay.includes(term.toLowerCase()));
}

/** The PRD §8 structured filters plus the D50 time bound, mock side (search-contract.md). */
function mockMatchesFilter(trace: Trace, filter: TraceFilter, sinceMs: number): boolean {
  const status = filter.status ?? "all";
  const maxCost = filter.maxCostUsd ?? -1;
  return (
    Date.parse(trace.startedAt) >= sinceMs &&
    (status === "all" || trace.status === status) &&
    trace.durationMs >= (filter.minMs ?? 0) &&
    trace.costUsd >= (filter.minCostUsd ?? 0) &&
    (maxCost < 0 || trace.costUsd <= maxCost) &&
    (!filter.service || trace.services.includes(filter.service)) &&
    (!filter.model || trace.models.includes(filter.model)) &&
    mockMatches(trace, filter.q ?? "")
  );
}

/**
 * Mock search over an explicit trace list: filter, order, page, exact filtered
 * total — the same D44 contract shape `queryTraceSearch` answers. The list is
 * a parameter so unit tests can prove pagination and ordering over fixtures
 * larger than a page; `searchTraces` below always passes `allTraces`. Order
 * matches live's `ORDER BY min(min_start) DESC, trace_id`: start descending,
 * then trace id ascending by codepoint (ClickHouse `String` order). Reference
 * clock (D50): the mock clock `NOW`, never the wall clock — mock traces are
 * generated inside ~6h behind `NOW`, so a wall-clock reference would empty
 * every mock surface (F6/F7).
 */
export function mockSearchTraces(all: Trace[], filter: TraceFilter): TraceSearchResult {
  const sinceMs = NOW - (filter.rangeMs ?? DEFAULT_TRACE_RANGE_MS);
  const matched = all
    .filter((t) => mockMatchesFilter(t, filter, sinceMs))
    .sort(
      (a, b) =>
        Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const start = (page - 1) * TRACE_PAGE_SIZE;
  return { traces: matched.slice(start, start + TRACE_PAGE_SIZE), total: matched.length };
}

export async function getTrace(id: string): Promise<Trace | undefined> {
  return dataMode === "live" ? queryTrace(id) : getMockTrace(id);
}

/** The traces-list entry point (D44): one page plus the exact filtered total. */
export async function searchTraces(filter: TraceFilter = {}): Promise<TraceSearchResult> {
  return dataMode === "live" ? queryTraceSearch(filter) : mockSearchTraces(allTraces, filter);
}

/**
 * Pre-D44 list shape: page 1 of `searchTraces`, total dropped. Still what
 * `app/traces/page.tsx` renders from; T4 (wave 2) moves that page onto
 * `searchTraces` and deletes this export along with the second unfiltered
 * read it exists to serve.
 */
export async function listTraces(filter: TraceFilter = {}): Promise<Trace[]> {
  return (await searchTraces(filter)).traces;
}

export async function getOverview(range: OverviewRange = "6h"): Promise<Overview> {
  if (dataMode === "live") return queryOverview(range);
  return { points: timeseries(), stats: [...statCards] };
}

/**
 * Mock free text on the LOGS surface — the mock half of the `/app/logs` search
 * rule (live half: `queries/logs.ts`). Reach is the **body only** (D51(e)): a
 * row this surface refuses to render must not be findable here either, and the
 * pod is a filter of its own rather than a search field. Terms come from the
 * one shared `splitSearchTerms`, AND across terms, case-insensitive substring —
 * the traces contract's term rules over this surface's narrower reach.
 */
export function mockLogMatches(line: LogLine, q: string): boolean {
  const body = line.body.toLowerCase();
  return splitSearchTerms(q).every((term) => body.includes(term.toLowerCase()));
}

/**
 * Mock `/app/logs` search over an explicit line list: filter, cap, pod options
 * — the same `LogSearchResult` shape `queryLogSearch` answers. The list is a
 * parameter so tests can drive fixtures the mock stream does not contain;
 * `searchLogs` below always passes `streamLogs`, which `mock/logstream.ts`
 * already sorts newest-first, so the rendered order matches live's
 * `ORDER BY timestamp DESC`. Reference clock (D50): the mock clock `NOW`, never
 * the wall clock — the mock stream lives inside ~6h behind `NOW` (F6/F7).
 *
 * The D42 content-carrier exclusion has no mock counterpart to apply: the mock
 * stream has no bodyless rows at all (data.test.ts guards that, so a mock that
 * grows carriers turns red here rather than rendering blank lines).
 */
export function mockSearchLogs(all: LogLine[], filter: LogFilter): LogSearchResult {
  const sinceMs = NOW - (filter.rangeMs ?? DEFAULT_LOG_RANGE_MS);
  const minRank = SEVERITY_ORDER.indexOf(filter.minSeverity ?? DEFAULT_LOG_SEVERITY);
  const inWindow = all.filter((line) => line.ts >= sinceMs);
  const matched = inWindow.filter(
    (line) =>
      SEVERITY_ORDER.indexOf(line.severity) >= minRank &&
      (!filter.pod || line.pod === filter.pod) &&
      (!filter.onTraceOnly || Boolean(line.traceId)) &&
      mockLogMatches(line, filter.q ?? ""),
  );
  return {
    ...capLogRows(matched),
    // Same rule as live: the window and the carrier state decide the options,
    // never the other filters.
    pods: [...new Set(inWindow.filter((line) => line.pod).map((line) => line.pod))].sort(),
    nowMs: NOW,
  };
}

/** The `/app/logs` entry point: one capped window plus its pod options (D44/D48). */
export async function searchLogs(filter: LogFilter = {}): Promise<LogSearchResult> {
  return dataMode === "live" ? queryLogSearch(filter) : mockSearchLogs(streamLogs, filter);
}
