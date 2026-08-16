import "server-only";
import type { Severity } from "@/lib/types";
import { queryRows, workspaceId } from "@/server/clickhouse";
import { splitSearchTerms } from "./traces";

/**
 * `/app/logs` reads `obstack.logs` directly — a peer of `queries/traces.ts`,
 * not a widening of it: nothing here joins a trace, and the rows this surface
 * renders are mostly rows no trace ever claims.
 *
 * D44 (sub-ruling): this surface does NOT paginate. It is a capped window —
 * `LOG_SEARCH_CAP` rows, fetched one past the cap so truncation is a fact
 * rather than an inference (the S2.2 E3 nearby-logs precedent). The header
 * states the rendered count, the applied bound and the truncation marker; it
 * never claims a row it did not render (D13/D21).
 */

/**
 * The rendered-row cap. `queryLogSearch` fetches `LOG_SEARCH_CAP + 1` and
 * `capLogRows` is the ONE place that slices to the cap and decides truncation,
 * from the same length check — a bare `=== LOG_SEARCH_CAP` count could never
 * tell "there is more" from "there was exactly that many" (E3).
 * Numerically equal to `TRACE_PAGE_SIZE` and `NEARBY_LOG_CAP` by history, not
 * by design: this is the logs window's own cap and moves on its own authority.
 */
export const LOG_SEARCH_CAP = 200;

/**
 * The severity floor vocabulary, weakest first — the index in this array IS the
 * rank the SQL below computes, so the filter, the stored rank and the rendered
 * label are one ordering with one definition.
 */
export const SEVERITY_ORDER: readonly Severity[] = ["debug", "info", "warn", "error", "fatal"];

/** The time-window vocabulary the URL carries; same tokens as `OverviewRange`. */
export type LogRange = "1h" | "6h" | "24h";

export const LOG_RANGES: Record<LogRange, number> = {
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
};

/**
 * D50: 6h is the one product-wide default range — the same window the traces
 * list and `getOverview` default to. `../data.test.ts` pins this equal to
 * `DEFAULT_TRACE_RANGE_MS`, so the two surfaces cannot drift into different
 * "defaults" while both headers claim one bound.
 */
export const DEFAULT_LOG_RANGE: LogRange = "6h";
export const DEFAULT_LOG_RANGE_MS = LOG_RANGES[DEFAULT_LOG_RANGE];

/** The `/app/logs` filter set, applied server-side in BOTH modes (D13). */
export interface LogFilter {
  /** free text over the log BODY only — see the reach note on `freeTextClauses` */
  q?: string;
  /** severity floor; absent = `"debug"`, i.e. no floor */
  minSeverity?: Severity;
  /** exact `k8s_pod` match; absent or empty = every pod */
  pod?: string;
  /** keep only rows carrying a trace id */
  onTraceOnly?: boolean;
  /** window back from the reference clock (D50); default `DEFAULT_LOG_RANGE_MS` */
  rangeMs?: number;
}

/**
 * One rendered log line. Absolute-time, unlike `LogRecord` (which is offset
 * from a trace's start): this surface has no trace to offset against.
 */
export interface LogLine {
  id: string;
  /** absolute epoch ms */
  ts: number;
  severity: Severity;
  body: string;
  /** `k8s_pod`, empty for senders that carry no k8s resource attributes */
  pod: string;
  traceId?: string;
}

export interface LogSearchResult {
  logs: LogLine[];
  /** true only when the cap+1 fetch PROVED more rows match (D13/D21) */
  truncated: boolean;
  /** every pod with a renderable row in the window — the filter's option list */
  pods: string[];
  /**
   * The reference clock this request bound its window to: the query's execution
   * time live, the mock clock in mock mode (D50). Row ages render against it
   * (D48), so the ages and the window can never disagree.
   */
  nowMs: number;
}

/**
 * OTel severity numbers → this surface's rank (an index into `SEVERITY_ORDER`).
 * It is computed in SQL because the floor filter must apply server-side (D13 —
 * no client-side re-filtering) and because the rank the filter judges has to be
 * the rank the row renders with: one expression does both jobs, so a row can
 * never be excluded as "info" and displayed as "error".
 *
 * The `severity_text` arm is not decoration: ingest clamps the number into a
 * UInt8 but never invents one (`internal/mapping/logs.go:49-55`), so a sender
 * that sets only a severity NAME lands here with `severity_number = 0`. The
 * trace rail's `toSeverity` (`adapters.ts`) is the same OTel table for the
 * trace-detail read path, which resolves it in JS after the rows are chosen;
 * this restatement exists because a filter cannot run there.
 */
const SEVERITY_RANK = `multiIf(
        severity_number >= 21, 4,
        severity_number >= 17, 3,
        severity_number >= 13, 2,
        severity_number >= 9, 1,
        severity_number >= 1, 0,
        lower(severity_text) IN ('fatal', 'critical'), 4,
        lower(severity_text) = 'error', 3,
        lower(severity_text) IN ('warn', 'warning'), 2,
        lower(severity_text) IN ('debug', 'trace'), 0,
        1)`;

/**
 * D51(e) / D42(d): `obstack.logs` carries GenAI **content carriers** — rows with
 * non-empty `prompt`/`completion` and an EMPTY `body` (`0002_logs.sql:20-21`).
 * They are structured content the trace view folds into `LlmDetail`, not log
 * lines, so on this surface they are excluded from RENDER, from the COUNT and
 * from the MATCH — the same predicate does all three, because a row this
 * surface refuses to render must not be findable here either ("count = what
 * rendered", D13/D21). Their content stays searchable where the UI actually
 * displays it: the traces-list prompts leg (D45).
 *
 * Same shape as the rail's `isContentCarrier` (`adapters.ts`), applied here in
 * SQL because this surface never loads the rows it excludes.
 */
const NOT_CONTENT_CARRIER = `NOT ((prompt != '' OR completion != '') AND body = '')`;

/**
 * Free text, this surface's reach: the log **`body` only** (D51(e)). Terms are
 * whitespace-split by the shared `splitSearchTerms` and ANDed — the traces-list
 * contract's term rules (`../search-contract.md`) over a narrower reach, and
 * the same Unicode fold: `positionCaseInsensitiveUTF8` (D56/D58(iii)), so the
 * two surfaces never disagree about what case-insensitive means.
 *
 * Placeholder-count generation is D45-sanctioned: the skeleton grows one
 * `{qN:String}` per term and every VALUE stays a bound parameter — splicing a
 * value in would be interpolation (D11, absolute).
 */
function freeTextClauses(termCount: number): string {
  let sql = "";
  for (let i = 0; i < termCount; i++) {
    sql += `\n  AND positionCaseInsensitiveUTF8(body, {q${i}:String}) > 0`;
  }
  return sql;
}

/**
 * The window read. `severity_rank` is referenced by name in the WHERE clause —
 * ClickHouse substitutes the alias, which is what keeps the filter and the
 * label a single expression.
 *
 * The ORDER BY is TOTAL over what the cap sees, and has to be: `obstack.logs`
 * has no unique key, so under a bare `ORDER BY timestamp DESC` two rows sharing
 * a timestamp come back in physical order — not stable across a merge — and the
 * slice below would keep a different row each time with no new data (the same
 * hazard LOGS_SQL's tiebreak chain closes in `traces.ts`).
 */
const logRowsSql = (termCount: number): string => `
SELECT
    toString(toUnixTimestamp64Milli(timestamp)) AS at_ms,
    trace_id,
    ${SEVERITY_RANK} AS severity_rank,
    body,
    k8s_pod
FROM obstack.logs
WHERE workspace_id = {workspace_id:String}
  AND timestamp >= fromUnixTimestamp64Milli({since_ms:Int64})
  AND ${NOT_CONTENT_CARRIER}
  AND severity_rank >= {min_rank:UInt8}
  AND ({pod:String} = '' OR k8s_pod = {pod:String})
  AND ({on_trace_only:UInt8} = 0 OR trace_id != '')${freeTextClauses(termCount)}
ORDER BY timestamp DESC, trace_id, k8s_pod, body
LIMIT {fetch_limit:UInt32}`;

/**
 * The pod filter's options, drawn from the data (D13 — the mock `podOptions`
 * list was the surface's option source until this task, so in live mode it
 * offered pods that do not exist). Deliberately narrowed by the WINDOW and the
 * carrier rule only, not by the other filters: an option list that shrank to
 * the pod already selected would be a control that eats itself. A pod with no
 * renderable row in the window is not offered.
 */
const POD_OPTIONS_SQL = `
SELECT DISTINCT k8s_pod
FROM obstack.logs
WHERE workspace_id = {workspace_id:String}
  AND timestamp >= fromUnixTimestamp64Milli({since_ms:Int64})
  AND k8s_pod != ''
  AND ${NOT_CONTENT_CARRIER}
ORDER BY k8s_pod`;

interface LogSearchRow {
  at_ms: string;
  trace_id: string;
  severity_rank: number;
  body: string;
  k8s_pod: string;
}

/**
 * `obstack.logs` has no unique key, so the render key is positional — the same
 * `${scope}-${index}` shape `toLogRecord` uses for the rail (`adapters.ts`).
 */
function toLogLine(row: LogSearchRow, index: number): LogLine {
  return {
    id: `${row.at_ms}-${index}`,
    ts: Number(row.at_ms),
    severity: SEVERITY_ORDER[row.severity_rank],
    body: row.body,
    pod: row.k8s_pod,
    traceId: row.trace_id || undefined,
  };
}

/**
 * The one place the cap is applied: the slice and the truncation flag come from
 * the same length check over a cap+1 fetch, so they can never drift (E3). Both
 * modes go through it — mock hands in every matching row, live hands in at most
 * `LOG_SEARCH_CAP + 1`.
 */
export function capLogRows(fetched: LogLine[]): { logs: LogLine[]; truncated: boolean } {
  return {
    logs: fetched.slice(0, LOG_SEARCH_CAP),
    truncated: fetched.length > LOG_SEARCH_CAP,
  };
}

/**
 * One `/app/logs` request: the capped window and its pod options, over one
 * reference clock sampled here and bound into both reads (D50) — two `now()`
 * evaluations could disagree and offer a pod the row window no longer covers.
 */
export async function queryLogSearch(filter: LogFilter): Promise<LogSearchResult> {
  const terms = splitSearchTerms(filter.q ?? "");
  const nowMs = Date.now();
  const sinceMs = nowMs - (filter.rangeMs ?? DEFAULT_LOG_RANGE_MS);
  const params: Record<string, unknown> = {
    workspace_id: workspaceId,
    since_ms: sinceMs,
    min_rank: SEVERITY_ORDER.indexOf(filter.minSeverity ?? "debug"),
    pod: filter.pod ?? "",
    on_trace_only: filter.onTraceOnly ? 1 : 0,
    fetch_limit: LOG_SEARCH_CAP + 1,
  };
  terms.forEach((term, i) => {
    params[`q${i}`] = term;
  });
  const [rows, pods] = await Promise.all([
    queryRows<LogSearchRow>(logRowsSql(terms.length), params),
    queryRows<{ k8s_pod: string }>(POD_OPTIONS_SQL, {
      workspace_id: workspaceId,
      since_ms: sinceMs,
    }),
  ]);
  return {
    ...capLogRows(rows.map(toLogLine)),
    pods: pods.map((row) => row.k8s_pod),
    nowMs,
  };
}
