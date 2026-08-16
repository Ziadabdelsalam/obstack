import "server-only";
import type { Trace } from "@/lib/types";
import { NEARBY_LOG_CAP, NEARBY_LOG_WINDOW_NS } from "@/lib/nearby-logs";
import {
  toTrace,
  toTraceSummary,
  type LogRow,
  type SpanRow,
  type TraceSummaryRow,
} from "@/server/adapters";
import { queryRows, workspaceId } from "@/server/clickhouse";

/** Both modes cap the list the same way; the traces UI has no pagination yet. */
export const DEFAULT_TRACE_LIMIT = 200;

export interface TraceFilter {
  /** free text over root name, trace id, models and services */
  q?: string;
  status?: "all" | "ok" | "error";
  minMs?: number;
  minCostUsd?: number;
  limit?: number;
}

/**
 * `trace_summaries` is an AggregatingMergeTree fed by a materialized view, so a
 * trace has one row per inserted block. Every read here groups by
 * (workspace_id, trace_id) and merges — plain min/max/sum for the
 * SimpleAggregateFunction columns, -Merge for the argMinIf roots. Never FINAL
 * (D7, binding).
 */
const SUMMARY_COLUMNS = `
    trace_id,
    toString(toUnixTimestamp64Nano(min(min_start)))                                    AS min_start_ns,
    toString(toUnixTimestamp64Milli(min(min_start)))                                   AS started_ms,
    toString(toUnixTimestamp64Nano(max(max_end)) - toUnixTimestamp64Nano(min(min_start))) AS duration_ns,
    toString(sum(span_count))                                                          AS span_count,
    toString(sum(error_count))                                                         AS error_count,
    toString(sum(total_input_tokens))                                                  AS input_tokens,
    toString(sum(total_output_tokens))                                                 AS output_tokens,
    sum(total_cost_usd)                                                                AS cost_usd,
    arraySort(groupUniqArrayArray(services))                                           AS services,
    arraySort(groupUniqArrayArray(models))                                             AS models,
    argMinIfMerge(root_name)                                                           AS root_name,
    argMinIfMerge(root_method)                                                         AS root_method,
    argMinIfMerge(root_service)                                                        AS root_service`;

const SUMMARY_BY_ID_SQL = `
SELECT ${SUMMARY_COLUMNS}
FROM obstack.trace_summaries
WHERE workspace_id = {workspace_id:String} AND trace_id = {trace_id:String}
GROUP BY workspace_id, trace_id`;

const SUMMARY_LIST_SQL = `
SELECT ${SUMMARY_COLUMNS}
FROM obstack.trace_summaries
WHERE workspace_id = {workspace_id:String}
GROUP BY workspace_id, trace_id
HAVING toUInt64(duration_ns) >= {min_ns:UInt64}
   AND cost_usd >= {min_cost:Float64}
   AND ({status:String} = 'all'
        OR ({status:String} = 'error' AND toUInt64(error_count) > 0)
        OR ({status:String} = 'ok' AND toUInt64(error_count) = 0))
   AND ({q:String} = ''
        OR positionCaseInsensitive(root_name, {q:String}) > 0
        OR positionCaseInsensitive(trace_id, {q:String}) > 0
        OR arrayExists(m -> positionCaseInsensitive(m, {q:String}) > 0, models)
        OR arrayExists(s -> positionCaseInsensitive(s, {q:String}) > 0, services))
ORDER BY min(min_start) DESC
LIMIT {limit:UInt32}`;

/** Spans of one trace, offsets resolved against the summary's `min_start` (D12). */
const SPANS_SQL = `
SELECT
    span_id,
    parent_span_id,
    name,
    toString(layer)                                                  AS layer,
    service,
    toString(toUnixTimestamp64Nano(start_time) - {min_start_ns:Int64}) AS start_offset_ns,
    toString(duration_ns)                                            AS duration_ns,
    toString(status_code)                                            AS status_code,
    status_message,
    k8s_pod,
    k8s_node,
    gen_ai_request_model,
    gen_ai_response_model,
    input_tokens,
    output_tokens,
    cost_usd,
    finish_reason,
    prompt,
    completion,
    attributes
FROM obstack.spans
WHERE workspace_id = {workspace_id:String} AND trace_id = {trace_id:String}
ORDER BY start_time, span_id`;

const LOGS_SQL = `
SELECT
    toString(toUnixTimestamp64Nano(timestamp) - {min_start_ns:Int64}) AS at_offset_ns,
    trace_id,
    severity_number,
    severity_text,
    body,
    k8s_namespace,
    k8s_pod,
    k8s_container
FROM obstack.logs
WHERE workspace_id = {workspace_id:String} AND trace_id = {trace_id:String}
ORDER BY timestamp`;

/**
 * Nearby logs (D37.4): a second, unrelated read from the solid one above —
 * candidates carry no trace context at all (`trace_id = ''`), so this is not a
 * widened version of `LOGS_SQL`. The join key is `(workspace_id, k8s_namespace,
 * k8s_pod)`, with the pod/namespace set drawn from the trace's own spans (kickoff
 * Decision 4) via a correlated subquery — no pod list is round-tripped through
 * JS. `obstack.logs` is `ORDER BY (workspace_id, trace_id, timestamp)`, and
 * trace-less rows sort together at `trace_id = ''`, so this is a contiguous
 * range read; `INDEX idx_pod k8s_pod TYPE bloom_filter` narrows it further
 * (0002_logs.sql:22,26). Window bound is `[min_start - W, max_end + W]`
 * (kickoff Decision 4), `W` = `NEARBY_LOG_WINDOW_NS`, computed here rather than
 * in JS so the Int64 arithmetic never touches a JS number.
 *
 * Selection (E2, reviewer-escalated): the inner subquery orders by proximity —
 * `greatest(min_start - ts, ts - max_end, 0)`, zero for any row inside the
 * trace's own `[min_start, max_end]` interval — before `timestamp` and the
 * existing tiebreak chain (`k8s_pod, k8s_container, body`; logs have no unique
 * key, so a bare `timestamp` sort under a LIMIT would let physical read order
 * decide which rows survive the cap). A chatty pod that emits more than
 * `NEARBY_LOG_CAP` trace-less rows in the window could otherwise fill the cap
 * with rows chronologically earliest in the window and evict rows that are
 * actually inside the trace's own span — proximity rank fixes that: in-interval
 * rows always sort first, so they are never evicted below `NEARBY_LOG_CAP`
 * other candidates. Below the cap this changes nothing: rank ties (mostly 0)
 * fall through to `timestamp` and the query returns the same set as before.
 *
 * Truncation (E3): fetches `NEARBY_LOG_CAP + 1` — the caller slices to
 * `NEARBY_LOG_CAP` and treats a fetch of `NEARBY_LOG_CAP + 1` as proof more
 * rows exist, rather than assuming it from a bare `= NEARBY_LOG_CAP` count
 * (indistinguishable from "there were exactly that many"). The slice has to
 * happen on THIS proximity order, not on a chronological one: an outer
 * `ORDER BY timestamp` here would put the extra row last by time rather than
 * last by priority, so the caller's slice could drop an in-interval row
 * instead of the lowest-priority filler it fetched purely to detect
 * truncation. Chronological order for the rail already comes from
 * `LogsRail.tsx`'s own `sort((a, b) => a.atMs - b.atMs)` before it renders —
 * this query does not need to re-sort what a downstream consumer already
 * sorts, and must not sort in a way that corrupts the slice above it.
 */
const NEARBY_LOGS_SQL = `
SELECT
    toString(toUnixTimestamp64Nano(timestamp) - {min_start_ns:Int64}) AS at_offset_ns,
    trace_id,
    severity_number,
    severity_text,
    body,
    k8s_namespace,
    k8s_pod,
    k8s_container
FROM obstack.logs
WHERE workspace_id = {workspace_id:String}
  AND trace_id = ''
  AND (k8s_namespace, k8s_pod) IN (
      SELECT DISTINCT k8s_namespace, k8s_pod
      FROM obstack.spans
      WHERE workspace_id = {workspace_id:String}
        AND trace_id = {trace_id:String}
        AND k8s_pod != ''
  )
  AND timestamp >= fromUnixTimestamp64Nano({min_start_ns:Int64} - {window_ns:Int64})
  AND timestamp <= fromUnixTimestamp64Nano({min_start_ns:Int64} + {duration_ns:Int64} + {window_ns:Int64})
ORDER BY
    greatest(
        {min_start_ns:Int64} - toUnixTimestamp64Nano(timestamp),
        toUnixTimestamp64Nano(timestamp) - ({min_start_ns:Int64} + {duration_ns:Int64}),
        0
    ),
    timestamp, k8s_pod, k8s_container, body
LIMIT {fetch_limit:UInt32}`;

/**
 * Trace detail: one summary lookup, then spans, solid logs and nearby logs by
 * (workspace_id, trace_id) — the nearby read is a peer of the solid one, not a
 * rewrite of it (D28).
 */
export async function queryTrace(id: string): Promise<Trace | undefined> {
  const [summary] = await queryRows<TraceSummaryRow>(SUMMARY_BY_ID_SQL, {
    workspace_id: workspaceId,
    trace_id: id,
  });
  if (!summary) return undefined;

  const params = {
    workspace_id: workspaceId,
    trace_id: id,
    min_start_ns: summary.min_start_ns,
  };
  const [spanRows, logRows, nearbyFetched] = await Promise.all([
    queryRows<SpanRow>(SPANS_SQL, params),
    queryRows<LogRow>(LOGS_SQL, params),
    queryRows<LogRow>(NEARBY_LOGS_SQL, {
      ...params,
      duration_ns: summary.duration_ns,
      window_ns: NEARBY_LOG_WINDOW_NS,
      fetch_limit: NEARBY_LOG_CAP + 1,
    }),
  ]);
  // E3: fetching one past the cap turns "truncated" into a fact instead of a
  // guess — a bare `=== NEARBY_LOG_CAP` count is indistinguishable from "there
  // were exactly that many". `nearbyFetched` is passed through UNSLICED —
  // `toTrace` (adapters.ts) is the one place that both slices to the cap and
  // sets `Trace.nearbyLogsTruncated`, from the same length check.
  return toTrace(summary, spanRows, logRows, nearbyFetched);
}

export async function queryTraceList(filter: TraceFilter): Promise<Trace[]> {
  const rows = await queryRows<TraceSummaryRow>(SUMMARY_LIST_SQL, {
    workspace_id: workspaceId,
    q: filter.q ?? "",
    status: filter.status ?? "all",
    min_ns: Math.round((filter.minMs ?? 0) * 1_000_000),
    min_cost: filter.minCostUsd ?? 0,
    limit: filter.limit ?? DEFAULT_TRACE_LIMIT,
  });
  return rows.map(toTraceSummary);
}
