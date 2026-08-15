import "server-only";
import type { Trace } from "@/lib/types";
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

/** Trace detail: one summary lookup, then spans and logs by (workspace_id, trace_id). */
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
  const [spanRows, logRows] = await Promise.all([
    queryRows<SpanRow>(SPANS_SQL, params),
    queryRows<LogRow>(LOGS_SQL, params),
  ]);
  return toTrace(summary, spanRows, logRows);
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
