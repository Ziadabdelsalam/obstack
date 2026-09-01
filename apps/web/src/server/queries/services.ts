import "server-only";
import { layerOrder } from "@/lib/layers";
import {
  RECENT_ERROR_TRACE_CAP,
  SERVICE_CAP,
  TOP_SPAN_NAME_CAP,
  WINDOW_HOURS,
  type ServiceDetail,
  type ServiceList,
  type ServiceRow,
} from "@/lib/services-types";
import type { Layer } from "@/lib/types";
import type { ScopedClickHouse } from "@/server/clickhouse";

/**
 * The trace-derived service catalog (D397). Everything here reads `spans`
 * except the detail's error-trace list, which reads `trace_summaries` under
 * the D7 house rule (GROUP BY workspace_id, trace_id + the matching
 * combinator; never FINAL).
 *
 * ONE window, always (D394): `WINDOW_HOURS` is bound as a parameter and no
 * function below takes a range. `spans` is `PARTITION BY toDate(start_time)`,
 * so the bound prunes partitions on its own — there is no `max_seen_date`
 * pre-filter to add, unlike the summaries reads.
 */

/** A span carrying no `service.name` does not name a service — the `trace_summaries_mv`'s own rule (`groupUniqArrayIf(toString(service), service != '')`), applied to the catalog. */
const NAMED_SERVICE = "service != ''";

/**
 * The per-service aggregate, one GROUP BY over the window's spans.
 *
 * `layer_counts` is the plurality rule's raw material: `sumMap` folds the
 * service's spans into (layer -> count) in the SAME pass as the counts and
 * quantiles, so the plurality layer costs no second read and no second scan.
 * The pick itself happens in the wrapper below, because ClickHouse cannot
 * reference an aggregate's alias from the same SELECT list.
 *
 * `service` is filtered here rather than in the wrapper so the detail's read
 * aggregates ONE service instead of every service and then discarding.
 */
const serviceAggregate = (oneService: boolean): string => `
    SELECT
        service                                                   AS name,
        count()                                                   AS span_count,
        countIf(status_code = 'error')                            AS error_count,
        sumMap([toString(layer)], [toUInt64(1)])                  AS layer_counts,
        ifNotFinite(quantile(0.5)(duration_ns) / 1e6, 0)          AS p50_ms,
        ifNotFinite(quantile(0.95)(duration_ns) / 1e6, 0)         AS p95_ms,
        sum(cost_usd)                                             AS cost_usd,
        arraySort(groupUniqArrayArray(arrayFilter(m -> m != '', [toString(gen_ai_request_model), toString(gen_ai_response_model)]))) AS models,
        formatDateTime(max(start_time), '%Y-%m-%dT%H:%iZ', 'UTC') AS last_seen_iso
    FROM obstack.spans
    WHERE workspace_id = {workspace_id:String}
      AND ${NAMED_SERVICE}
      AND start_time >= now() - toIntervalHour({window_hours:UInt32})${oneService ? "\n      AND service = {service:String}" : ""}
    GROUP BY service`;

/**
 * The row columns both callers select, including the plurality layer.
 *
 * Plurality with a DETERMINISTIC tie-break: the (layer, count) pairs are
 * zipped with each layer's index in `layerOrder` — bound as a parameter, never
 * spliced (D11) — and sorted by count descending, then by that index. A
 * service with equal span counts in two layers therefore always renders the
 * one `layerOrder` names first, rather than whichever `topK`/`argMax` happened
 * to see first. `indexOf` returns 0 for a value outside the list, which sorts
 * ahead of everything; the DDL's enum holds exactly `layerOrder`'s six values,
 * so that branch has nothing to reach.
 */
const ROW_COLUMNS = `
    name,
    arraySort(t -> (-t.2, t.3), arrayZip(
        layer_counts.1,
        arrayMap(c -> toInt64(c), layer_counts.2),
        arrayMap(l -> indexOf({layer_order:Array(String)}, l), layer_counts.1)))[1].1 AS layer,
    toString(span_count)  AS spans,
    toString(error_count) AS errors,
    p50_ms,
    p95_ms,
    cost_usd,
    models,
    last_seen_iso`;

/**
 * D402: the cap and the total it truncated are ONE answer, so the total is a
 * window function over the same grouped set rather than a second read that
 * could disagree with it — `count() OVER ()` is evaluated before ORDER BY and
 * LIMIT (measured against the pinned engine: 4 services, `LIMIT 1`, total 4).
 *
 * The ranking is span volume, and the surface says so; `name` breaks ties, so
 * two services with identical counts never swap places between renders.
 */
const LIST_SQL = `
SELECT ${ROW_COLUMNS},
    toString(count() OVER ()) AS total_services
FROM (${serviceAggregate(false)}
)
ORDER BY span_count DESC, name
LIMIT {cap:UInt32}`;

const DETAIL_ROW_SQL = `
SELECT ${ROW_COLUMNS}
FROM (${serviceAggregate(true)}
)`;

/** Same cap-plus-total shape as the catalog: span names are as unbounded a GROUP BY as services are. */
const TOP_SPAN_NAMES_SQL = `
SELECT
    name,
    toString(span_count) AS spans,
    toString(error_count) AS errors,
    toString(count() OVER ()) AS total_names
FROM (
    SELECT
        name,
        count()                        AS span_count,
        countIf(status_code = 'error') AS error_count
    FROM obstack.spans
    WHERE workspace_id = {workspace_id:String}
      AND service = {service:String}
      AND start_time >= now() - toIntervalHour({window_hours:UInt32})
    GROUP BY name
)
ORDER BY span_count DESC, name
LIMIT {cap:UInt32}`;

/**
 * The one read in this module that is not over `spans` (D395's table split).
 * `trace_summaries` is an AggregatingMergeTree fed per inserted block, so this
 * merges every partial row of a trace before judging it — `has` and the error
 * test read the MERGED arrays and sums, never a single part's (D7; never
 * FINAL, never a bare SELECT).
 *
 * `max_seen_date` prunes cheaply in WHERE; the exact window bound is applied to
 * the merged `min_start` in HAVING, where the trace's real start finally exists.
 *
 * A trace qualifies when it carries this service AND at least one error span —
 * that error may belong to another service of the same trace, which is what
 * the summaries table can answer. `ServiceDetailLive` states this in words.
 */
const RECENT_ERROR_TRACES_SQL = `
SELECT
    trace_id,
    argMinIfMerge(root_name)                                 AS root_name,
    formatDateTime(min(min_start), '%Y-%m-%dT%H:%iZ', 'UTC') AS started_iso
FROM obstack.trace_summaries
WHERE workspace_id = {workspace_id:String}
  AND max_seen_date >= toDate(now() - toIntervalHour({window_hours:UInt32}))
GROUP BY workspace_id, trace_id
HAVING has(groupUniqArrayArray(services), {service:String})
   AND sum(error_count) > 0
   AND min(min_start) >= now() - toIntervalHour({window_hours:UInt32})
ORDER BY min(min_start) DESC, trace_id
LIMIT {cap:UInt32}`;

interface RowSql {
  name: string;
  layer: string;
  spans: string;
  errors: string;
  p50_ms: number;
  p95_ms: number;
  cost_usd: number;
  models: string[];
  last_seen_iso: string;
}

interface ListRowSql extends RowSql {
  total_services: string;
}

interface SpanNameSql {
  name: string;
  spans: string;
  errors: string;
  total_names: string;
}

interface ErrorTraceSql {
  trace_id: string;
  root_name: string;
  started_iso: string;
}

/** The enum's catch-all (D22) for anything outside `layerOrder`, rather than a cast that would let a non-Layer through. */
const asLayer = (raw: string): Layer =>
  (layerOrder as string[]).includes(raw) ? (raw as Layer) : "other";

/** Error spans ÷ spans × 100 — the one definition, stated on every surface that renders it. */
const errorPct = (errors: number, spans: number): number => (spans === 0 ? 0 : (errors / spans) * 100);

function toRow(row: RowSql): ServiceRow {
  const spans = Number(row.spans);
  return {
    name: row.name,
    layer: asLayer(row.layer),
    spans,
    // The window's average, not an instantaneous rate — `WINDOW_HOURS` is the
    // only divisor, so the number cannot drift from the window it names.
    spansPerMin: spans / (WINDOW_HOURS * 60),
    errorPct: errorPct(Number(row.errors), spans),
    p50Ms: row.p50_ms,
    p95Ms: row.p95_ms,
    costUsd: row.cost_usd,
    models: row.models,
    lastSeenAt: row.last_seen_iso,
  };
}

/** The catalog: the top `SERVICE_CAP` services by span volume, plus the true total behind the cap. */
export async function listServices(ch: ScopedClickHouse): Promise<ServiceList> {
  const rows = await ch.queryRows<ListRowSql>(LIST_SQL, {
    window_hours: WINDOW_HOURS,
    layer_order: layerOrder,
    cap: SERVICE_CAP,
  });
  return {
    rows: rows.map(toRow),
    // Every row carries the same window-function total; no rows means no
    // services, which is the only case where the total is not on a row.
    totalServices: rows.length === 0 ? 0 : Number(rows[0].total_services),
  };
}

/**
 * One service's detail, or `null` when the workspace sent no span from it in
 * the window — an unknown name and a silent one are the same answer here, and
 * the page states it as such rather than inventing an empty scorecard.
 *
 * Three reads in parallel (the `connections/page.tsx:50` idiom): the two extra
 * reads a `null` result throws away cost one round trip, and the common case —
 * a service that exists — pays for one instead of two.
 */
export async function getService(ch: ScopedClickHouse, name: string): Promise<ServiceDetail | null> {
  const [rows, spanNames, errorTraces] = await Promise.all([
    ch.queryRows<RowSql>(DETAIL_ROW_SQL, {
      window_hours: WINDOW_HOURS,
      layer_order: layerOrder,
      service: name,
    }),
    ch.queryRows<SpanNameSql>(TOP_SPAN_NAMES_SQL, {
      window_hours: WINDOW_HOURS,
      service: name,
      cap: TOP_SPAN_NAME_CAP,
    }),
    ch.queryRows<ErrorTraceSql>(RECENT_ERROR_TRACES_SQL, {
      window_hours: WINDOW_HOURS,
      service: name,
      cap: RECENT_ERROR_TRACE_CAP,
    }),
  ]);
  if (rows.length === 0) return null;

  return {
    ...toRow(rows[0]),
    topSpanNames: spanNames.map((row) => {
      const count = Number(row.spans);
      return { name: row.name, count, errorPct: errorPct(Number(row.errors), count) };
    }),
    totalSpanNames: spanNames.length === 0 ? 0 : Number(spanNames[0].total_names),
    recentErrorTraces: errorTraces.map((row) => ({
      traceId: row.trace_id,
      rootName: row.root_name,
      startedAt: row.started_iso,
    })),
  };
}
