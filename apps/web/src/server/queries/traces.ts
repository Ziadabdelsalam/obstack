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

/**
 * D44: the traces list is offset/limit paginated with an exact filtered total
 * per request. The page size is fixed here; the page number lives in the URL
 * (T4). 200 is the pre-pagination list cap carried forward as the page size.
 */
export const TRACE_PAGE_SIZE = 200;

/**
 * D50: every list query carries an explicit time bound; 6h is the one
 * product-wide default (matches `getOverview`'s default range and the shipped
 * header copy). The reference clock is per mode — see ../search-contract.md.
 */
export const DEFAULT_TRACE_RANGE_MS = 6 * 3_600_000;

/**
 * The traces-list filter (PRD §8): service, status, duration, model, cost
 * range, free text, time range — applied server-side in BOTH modes under one
 * matching contract (../search-contract.md).
 */
export interface TraceFilter {
  /** free text per the search contract (../search-contract.md) */
  q?: string;
  status?: "all" | "ok" | "error";
  /** exact membership in the trace's services */
  service?: string;
  /** exact membership in the trace's models */
  model?: string;
  minMs?: number;
  minCostUsd?: number;
  /** cost-range upper bound; absent or negative = unbounded */
  maxCostUsd?: number;
  /** time window back from the reference clock (D50); default `DEFAULT_TRACE_RANGE_MS` */
  rangeMs?: number;
  /** 1-based page of `TRACE_PAGE_SIZE` rows (D44); default 1 */
  page?: number;
}

/** One page of the traces list plus the exact filtered total (D44). */
export interface TraceSearchResult {
  traces: Trace[];
  /** count over the same filtered predicate as the page — never the page length */
  total: number;
}

/**
 * Whitespace-split free text into terms (../search-contract.md). Both
 * implementations tokenize through this one function, so the "what is a term"
 * clause of the contract cannot fork between modes.
 */
export function splitSearchTerms(q: string): string[] {
  return q.split(/\s+/).filter(Boolean);
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

/**
 * Free-text legs (D45, ../search-contract.md): per term, OR across the summary
 * fields and two trace-id SEMI-JOINS — `trace_summaries` stays the only row
 * source (PRD §7/§8 as amended by D45); the spans/logs legs return ids, never
 * rows. The logs leg reads trace-carrying rows only (`trace_id != ''`) and
 * includes the D42 content-carrier columns: carriers are excluded from the
 * rail's DISPLAY (adapters.ts), but their content is what the UI folds into
 * `LlmDetail`, so it is in the search REACH.
 *
 * `trace_id != ''` is load-bearing, not decorative: the summaries materialized
 * view has no write-side trace-id filter, so a span arriving without a trace id
 * yields a real summary row at `trace_id = ''`. Without the clause a matching
 * trace-less log hands `''` to the semi-join, that summary satisfies the `IN`,
 * and the list renders a phantom trace with an empty id. The integration
 * suite's trace-less subtest seeds that summary and goes red on removal.
 *
 * Placeholder-count generation is D45-sanctioned: the skeleton grows one
 * `{qN:String}` placeholder set per term, but every VALUE stays a bound
 * parameter — splicing a value into the string would be interpolation (D11,
 * absolute).
 */
function freeTextClauses(termCount: number): string {
  let sql = "";
  for (let i = 0; i < termCount; i++) {
    const q = `{q${i}:String}`;
    sql += `
   AND (positionCaseInsensitive(root_name, ${q}) > 0
        OR positionCaseInsensitive(trace_id, ${q}) > 0
        OR arrayExists(m -> positionCaseInsensitive(m, ${q}) > 0, models)
        OR arrayExists(s -> positionCaseInsensitive(s, ${q}) > 0, services)
        OR trace_id IN (
            SELECT trace_id FROM obstack.spans
            WHERE workspace_id = {workspace_id:String}
              AND (positionCaseInsensitive(name, ${q}) > 0
                   OR positionCaseInsensitive(prompt, ${q}) > 0
                   OR positionCaseInsensitive(completion, ${q}) > 0))
        OR trace_id IN (
            SELECT trace_id FROM obstack.logs
            WHERE workspace_id = {workspace_id:String}
              AND trace_id != ''
              AND (positionCaseInsensitive(body, ${q}) > 0
                   OR positionCaseInsensitive(prompt, ${q}) > 0
                   OR positionCaseInsensitive(completion, ${q}) > 0)))`;
  }
  return sql;
}

/**
 * The grouped, filtered read the page and the count SHARE (D44: the total is
 * computed over the same WHERE/HAVING as the page — one skeleton, assembled
 * once per request, so the two can never drift). The D7 GROUP-BY rule (never
 * FINAL, never a bare SELECT) applies to the count subquery identically —
 * `count()` wraps this grouped read rather than counting raw summary rows.
 *
 * Every structured filter lives in HAVING because each one (min_start,
 * duration, cost, status, services, models) is an aggregate of the trace's
 * partial rows — a WHERE would judge each partial row alone and drop traces
 * whose aggregates only pass once merged.
 */
const filteredSummariesSql = (termCount: number): string => `
SELECT ${SUMMARY_COLUMNS}
FROM obstack.trace_summaries
WHERE workspace_id = {workspace_id:String}
GROUP BY workspace_id, trace_id
HAVING min(min_start) >= fromUnixTimestamp64Milli({since_ms:Int64})
   AND toUInt64(duration_ns) >= {min_ns:UInt64}
   AND cost_usd >= {min_cost:Float64}
   AND ({max_cost:Float64} < 0 OR cost_usd <= {max_cost:Float64})
   AND ({status:String} = 'all'
        OR ({status:String} = 'error' AND toUInt64(error_count) > 0)
        OR ({status:String} = 'ok' AND toUInt64(error_count) = 0))
   AND ({service:String} = '' OR has(services, {service:String}))
   AND ({model:String} = '' OR has(models, {model:String}))${freeTextClauses(termCount)}`;

/**
 * D44 page order: `ORDER BY min(min_start) DESC, trace_id` — the tie-break is
 * mandatory; offset paging over a tie-unstable sort returns overlapping pages
 * after a merge.
 */
const searchPageSql = (termCount: number): string => `${filteredSummariesSql(termCount)}
ORDER BY min(min_start) DESC, trace_id
LIMIT {limit:UInt32} OFFSET {offset:UInt32}`;

const searchCountSql = (termCount: number): string => `
SELECT count() AS total
FROM (${filteredSummariesSql(termCount)})`;

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

/**
 * `span_id`/`prompt`/`completion` (D38 FINAL / D42, T6): the log-record GenAI
 * wire form lands its content on its own row here, keyed back to the LLM span
 * by `span_id` (D42(d) — the read-time coalesce in `adapters.ts` matches on
 * `(workspace_id, trace_id, span_id)`, and `workspace_id`/`trace_id` are
 * already this query's WHERE clause). NEARBY_LOGS_SQL below does not select
 * these: its rows always carry `trace_id = ''`, which can never match this
 * trace's own trace_id, so a nearby row can never be a coalesce candidate.
 *
 * The ORDER BY is TOTAL over what the fold reads, and has to be: D42(d) makes
 * "earliest timestamp wins" a contract, and `obstack.logs` has no unique key,
 * so under a bare `ORDER BY timestamp` two content rows for the same span at
 * the same timestamp come back in physical order — which is not stable. Two
 * such rows landing in different parts flip their relative order once
 * ClickHouse merges those parts, so the folded prompt/completion for a trace
 * would silently change value with no new data (verified against a seeded
 * server: the same SELECT returns a different first row before and after
 * `OPTIMIZE`). Tie-breaking on `span_id, prompt, completion` makes the fold's
 * OUTCOME deterministic — rows that tie on all four carry the same content, so
 * whichever wins produces the same value. Sort cost is nil in practice: the
 * comparison only reaches the String columns when timestamp and span_id are
 * equal, over one trace's own log rows.
 */
const LOGS_SQL = `
SELECT
    span_id,
    toString(toUnixTimestamp64Nano(timestamp) - {min_start_ns:Int64}) AS at_offset_ns,
    trace_id,
    severity_number,
    severity_text,
    body,
    prompt,
    completion,
    k8s_namespace,
    k8s_pod,
    k8s_container
FROM obstack.logs
WHERE workspace_id = {workspace_id:String} AND trace_id = {trace_id:String}
ORDER BY timestamp, span_id, prompt, completion`;

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

/**
 * One traces-list request (D44): the page and its exact filtered total,
 * computed concurrently over the same predicate — the live half of the search
 * contract (../search-contract.md). The D50 reference clock is sampled ONCE
 * here and bound into both queries; two separate `now()` evaluations could
 * disagree across them and break "the total is the page's own predicate".
 */
export async function queryTraceSearch(filter: TraceFilter): Promise<TraceSearchResult> {
  const terms = splitSearchTerms(filter.q ?? "");
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const params: Record<string, unknown> = {
    workspace_id: workspaceId,
    since_ms: Date.now() - (filter.rangeMs ?? DEFAULT_TRACE_RANGE_MS),
    min_ns: Math.round((filter.minMs ?? 0) * 1_000_000),
    min_cost: filter.minCostUsd ?? 0,
    max_cost: filter.maxCostUsd ?? -1,
    status: filter.status ?? "all",
    service: filter.service ?? "",
    model: filter.model ?? "",
    limit: TRACE_PAGE_SIZE,
    offset: (page - 1) * TRACE_PAGE_SIZE,
  };
  terms.forEach((term, i) => {
    params[`q${i}`] = term;
  });
  const [rows, counts] = await Promise.all([
    queryRows<TraceSummaryRow>(searchPageSql(terms.length), params),
    queryRows<{ total: string }>(searchCountSql(terms.length), params),
  ]);
  return { traces: rows.map(toTraceSummary), total: Number(counts[0]?.total ?? 0) };
}
