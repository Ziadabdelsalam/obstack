import "server-only";
import type { Trace } from "@/lib/types";
import { statCards, timeseries } from "@/mock/metrics";
import { allTraces, getTrace as getMockTrace } from "@/mock/traces";
import {
  queryOverview,
  type Overview,
  type OverviewRange,
} from "@/server/queries/overview";
import {
  DEFAULT_TRACE_LIMIT,
  queryTrace,
  queryTraceList,
  type TraceFilter,
} from "@/server/queries/traces";

export type {
  Overview,
  OverviewPoint,
  OverviewRange,
  OverviewStat,
} from "@/server/queries/overview";
export type { TraceFilter } from "@/server/queries/traces";

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

/** Mock search keeps its full-text reach over spans and logs; live search is summary-level. */
function mockMatches(trace: Trace, q: string): boolean {
  if (!q) return true;
  const hay = [
    trace.rootName,
    trace.id,
    ...trace.models,
    ...trace.services,
    ...trace.spans.map((s) => s.name),
    ...trace.spans.map((s) => s.llm?.prompt ?? ""),
    ...trace.logs.map((l) => l.body),
  ]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((term) => hay.includes(term));
}

export async function getTrace(id: string): Promise<Trace | undefined> {
  return dataMode === "live" ? queryTrace(id) : getMockTrace(id);
}

export async function listTraces(filter: TraceFilter = {}): Promise<Trace[]> {
  if (dataMode === "live") return queryTraceList(filter);
  const status = filter.status ?? "all";
  return allTraces
    .filter(
      (t) =>
        (status === "all" || t.status === status) &&
        t.durationMs >= (filter.minMs ?? 0) &&
        t.costUsd >= (filter.minCostUsd ?? 0) &&
        mockMatches(t, filter.q ?? ""),
    )
    .slice(0, filter.limit ?? DEFAULT_TRACE_LIMIT);
}

export async function getOverview(range: OverviewRange = "6h"): Promise<Overview> {
  if (dataMode === "live") return queryOverview(range);
  return { points: timeseries(), stats: [...statCards] };
}
