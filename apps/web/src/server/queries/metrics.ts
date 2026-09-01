import "server-only";
import type {
  MetricAgg,
  MetricCatalogEntry,
  MetricRange,
  MetricSeriesPoint,
  MetricSeriesQuery,
  MetricSeriesResult,
} from "@/lib/metrics-types";
import type { ScopedClickHouse } from "@/server/clickhouse";

type MetricType = "gauge" | "sum" | "histogram";

// ---- catalog (D363 packet §0, from `metric_series`, never raw) -------------

/**
 * `metric_series` earns its keep as the catalog source (D363 §3): no raw scan.
 * The inner subquery merges at the table's real physical key — D374 ruled
 * `metric_series_mv`'s GROUP BY as `workspace_id, name, series_hash, type,
 * unit, service` (SQL-complete: type/unit/service are plain, non-aggregate
 * columns in an AggregatingMergeTree, so a query that omits them from its
 * merge key can get an arbitrary pick between parts — this is the "never
 * FINAL" rule applied to those three columns, not just the aggregate ones).
 *
 * The outer GROUP BY collapses to (name, type) per D378: a metric name
 * genuinely emitted as two types (a mapping bug, or two SDKs disagreeing)
 * renders as TWO catalog rows — never an `anyLast(type)` pick that would
 * silently hide one of them. `unit` can legitimately differ across the
 * series folded into one (name, type) row (unit is part of the same merge
 * key upstream); `argMax(unit, last_seen)` reports the most recently
 * observed one, consistent with "the catalog tells the truth about now".
 *
 * The `last_seen`/`last_seen_iso` aliasing below is deliberate: naming the
 * outer alias the same as the inner column it depends on (`last_seen`) trips
 * a real engine bug on clickhouse-server 26.3.17.110 — `argMax(unit,
 * last_seen)` alongside an aggregate that also produces an output column
 * named `last_seen` raises `ILLEGAL_AGGREGATION` ("aggregate function
 * max(last_seen) is found inside another aggregate function"), measured
 * directly against the pinned engine. A distinct alias sidesteps it entirely,
 * including for the `formatDateTime` that renders the contract's ISO UTC
 * minute (measured on the same engine: the alias name was the whole bug).
 */
const CATALOG_SQL = `
SELECT
    name,
    type,
    argMax(unit, last_seen)                                                   AS unit,
    formatDateTime(toStartOfMinute(max(last_seen)), '%Y-%m-%dT%H:%iZ', 'UTC') AS last_seen_iso,
    arraySort(groupUniqArrayArray(mapKeys(attributes)))                       AS attr_keys
FROM (
    SELECT
        workspace_id, name, series_hash, toString(type) AS type, unit, service,
        anyLast(attributes) AS attributes,
        max(last_seen)      AS last_seen
    FROM obstack.metric_series
    WHERE workspace_id = {workspace_id:String}
    GROUP BY workspace_id, name, series_hash, type, unit, service
)
GROUP BY name, type
ORDER BY name, type`;

interface CatalogRow {
  name: string;
  type: MetricType;
  unit: string;
  last_seen_iso: string; // "YYYY-MM-DDTHH:MMZ" — the contract's ISO UTC minute, formatted server-side
  attr_keys: string[];
}

export async function listMetricCatalog(ch: ScopedClickHouse): Promise<MetricCatalogEntry[]> {
  const rows = await ch.queryRows<CatalogRow>(CATALOG_SQL);
  return rows.map((row) => ({
    name: row.name,
    type: row.type,
    unit: row.unit,
    lastSeen: row.last_seen_iso,
    attrKeys: row.attr_keys,
  }));
}

// ---- histogram quantile (packet §5 condition 3: one SQL/TS function, -------
// ---- unit-tested against a known distribution with exact quantiles) -------

/**
 * Linear-interpolation quantile over an OTel explicit-bounds histogram
 * (`bounds[i]` are the upper edges of the finite buckets; `counts.length ===
 * bounds.length + 1`, with `counts[0]` = `(-inf, bounds[0]]` and
 * `counts[counts.length - 1]` = `(bounds[bounds.length - 1], +inf)`). The
 * packet names this "arrayCumSum + first-index" (Q1) and leaves the
 * implementation language open ("one SQL/TS function", packet §5 condition
 * 3); this is the TS half — a pure function is exactly as correct and does
 * not need a live server to unit-test against exact expected values, unlike
 * the nested array-function SQL form measured during design (both compute
 * the identical interpolation).
 *
 * Returns `null` when the merged histogram carries no samples (`total ===
 * 0`) — an empty bucket is a gap, not a zero (D363 §0 binding).
 */
export function histogramQuantile(bounds: number[], counts: number[], q: number): number | null {
  const total = counts.reduce((sum, c) => sum + c, 0);
  if (total <= 0) return null;
  const target = q * total;
  let cumulative = 0;
  for (let i = 0; i < counts.length; i++) {
    const next = cumulative + counts[i];
    if (target <= next) {
      const lower = i === 0 ? undefined : bounds[i - 1];
      const upper = i === counts.length - 1 ? undefined : bounds[i];
      // veteran: the unbounded edge buckets (below the first / above the
      // last finite bound) have no far edge to interpolate against — this
      // reports the nearest known boundary rather than extrapolating past
      // it. Upgrade path: fold `h_min`/`h_max` in if a tail sample ever
      // needs to be exact rather than clamped (not observed as a product
      // need yet — explore only renders p50/p90/p95/p99 quantile LINES).
      // A histogram with EMPTY bounds is one open bucket with no edge at
      // either end (legal OTLP): there is no number to report, so it is a
      // gap like any other unknown, never a fabricated 0.
      if (lower === undefined && upper === undefined) return null;
      if (lower === undefined) return upper as number;
      if (upper === undefined) return lower;
      const fraction = counts[i] > 0 ? (target - cumulative) / counts[i] : 0;
      return lower + fraction * (upper - lower);
    }
    cumulative = next;
  }
  // Unreachable while total > 0 (the loop's cumulative reaches `total` by the
  // last bucket, and target <= total by construction) — a defined return
  // rather than a non-null assertion.
  return null;
}

// ---- series query (D363 packet §0, from `metric_points_1m`) ---------------

const RANGES: Record<MetricRange, { bucketMinutes: number; points: number }> = {
  "1h": { bucketMinutes: 1, points: 60 },
  "6h": { bucketMinutes: 5, points: 72 },
  "24h": { bucketMinutes: 15, points: 96 },
};

/** Validity by type (D363 §0, binding): an agg outside its type's set is a request error, never a silent coercion. */
const VALID_AGGS: Record<MetricType, MetricAgg[]> = {
  gauge: ["avg", "min", "max", "last"],
  sum: ["sum", "rate"],
  histogram: ["p50", "p90", "p95", "p99", "avg"],
};

/**
 * Builds the two-level read over `metric_points_1m` (D363 §3's rollup, the
 * trace_summaries house rule carried over verbatim): the inner query GROUPs
 * BY the series key (`series_hash`) plus the requested bucket width and the
 * groupBy attribute (or a constant for the ungrouped case) — never FINAL,
 * never a bare SELECT. `avg`/`gauge_last`/histogram `hist_counts` are
 * re-emitted as `-MergeState` rather than finalized here, because
 * avg-of-avgs (and argMax-of-argMaxes) across the OUTER regroup would be
 * mathematically wrong; only the outer query finalizes them, with a single
 * `-Merge` each. `sum`/`min`/`max`/`anyLast` are associative and safe to
 * re-apply directly at both levels (measured against the pinned engine:
 * combining across sub-buckets and combining across series in one group are
 * the same operation to these combinators, regardless of which physical rows
 * or parts contributed).
 */
function seriesSql(filterCount: number, grouped: boolean): string {
  const filterClauses = Array.from(
    { length: filterCount },
    (_, i) => `      AND attributes[{f${i}k:String}] = {f${i}v:String}`,
  ).join("\n");
  const groupGate = grouped ? "      AND mapContains(attributes, {group_by:String})" : "";
  const groupExpr = grouped ? "attributes[{group_by:String}]" : "''";
  return `
SELECT
    grp,
    toUInt32(toUnixTimestamp(wide_bucket))                            AS bucket_epoch_s,
    sum(sum_delta)                                                    AS sum_delta,
    min(gauge_min)                                                    AS gauge_min,
    max(gauge_max)                                                    AS gauge_max,
    avgMerge(gauge_avg_state)                                         AS gauge_avg,
    argMaxMerge(gauge_last_state)                                     AS gauge_last,
    anyLast(bounds)                                                   AS bounds,
    arrayMap(x -> toFloat64(x), sumForEachMerge(hist_counts_state))   AS hist_counts,
    sum(h_sum)                                                        AS h_sum,
    toFloat64(sum(h_count))                                           AS h_count
FROM (
    SELECT
        series_hash,
        toStartOfInterval(bucket, INTERVAL {bucket_minutes:UInt32} MINUTE) AS wide_bucket,
        ${groupExpr} AS grp,
        sum(sum_delta)                     AS sum_delta,
        min(gauge_min)                     AS gauge_min,
        max(gauge_max)                     AS gauge_max,
        avgMergeState(gauge_avg)           AS gauge_avg_state,
        argMaxMergeState(gauge_last)       AS gauge_last_state,
        anyLast(bounds)                    AS bounds,
        sumForEachMergeState(hist_counts)  AS hist_counts_state,
        sum(h_sum)                         AS h_sum,
        sum(h_count)                       AS h_count
    FROM obstack.metric_points_1m
    WHERE workspace_id = {workspace_id:String}
      AND name = {metric:String}
      AND type = {type:String}
      AND bucket >= fromUnixTimestamp({since_s:UInt32})
      AND bucket < fromUnixTimestamp({until_s:UInt32})
${groupGate}
${filterClauses}
    GROUP BY series_hash, wide_bucket, grp
)
GROUP BY grp, wide_bucket
ORDER BY grp, wide_bucket`;
}

interface RollupRow {
  grp: string;
  bucket_epoch_s: number;
  sum_delta: number;
  gauge_min: number;
  gauge_max: number;
  gauge_avg: number;
  gauge_last: number;
  bounds: number[];
  hist_counts: number[];
  h_sum: number;
  h_count: number;
}

/** `sum_delta / bucket-seconds` per the packet's own rate definition (D363 §3's `metric_points_1m` comment). */
function pointValue(type: MetricType, agg: MetricAgg, row: RollupRow, bucketSeconds: number): number | null {
  switch (type) {
    case "gauge":
      switch (agg) {
        case "avg":
          return row.gauge_avg;
        case "min":
          return row.gauge_min;
        case "max":
          return row.gauge_max;
        case "last":
          return row.gauge_last;
        default:
          throw new Error(`unreachable: "${agg}" already validated against type "gauge"`);
      }
    case "sum":
      switch (agg) {
        case "sum":
          return row.sum_delta;
        case "rate":
          return row.sum_delta / bucketSeconds;
        default:
          throw new Error(`unreachable: "${agg}" already validated against type "sum"`);
      }
    case "histogram":
      switch (agg) {
        case "avg":
          return row.h_count > 0 ? row.h_sum / row.h_count : null;
        case "p50":
          return histogramQuantile(row.bounds, row.hist_counts, 0.5);
        case "p90":
          return histogramQuantile(row.bounds, row.hist_counts, 0.9);
        case "p95":
          return histogramQuantile(row.bounds, row.hist_counts, 0.95);
        case "p99":
          return histogramQuantile(row.bounds, row.hist_counts, 0.99);
        default:
          throw new Error(`unreachable: "${agg}" already validated against type "histogram"`);
      }
  }
}

/** `"HH:MM"` UTC — matches `overview.ts`'s `OverviewPoint.t` convention for the same dashboard charts. */
function hhmmUtc(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * `queryMetricSeries` (D363 §0, frozen; `type` REQUIRED per D384). The caller
 * supplies the type, so there is no catalog lookup here at all: an unknown
 * (name, type) pair simply matches zero rows in `metric_points_1m` and takes
 * the SAME honest-empty-result path as any other empty query — never a
 * separate "no such metric" check with its own round trip (D378's
 * dual-emission ceiling is retired by this: `type` disambiguates a
 * dual-emitted name directly, rather than a `resolveType` heuristic guessing
 * at it). Agg-vs-type validity is checked synchronously against the SUPPLIED
 * type, before any statement reaches ClickHouse (D363 §0's binding "invalid
 * agg-for-type is a request error").
 *
 * The bucket grid is generated here, not left to whatever rows the SQL
 * happens to return — a bucket with no matching data must still render as
 * `v: null` (an honest gap), never be absent from `points` or coerced to
 * `0`. Grid boundaries are computed with the SAME epoch-anchored flooring
 * `toStartOfInterval(DateTime, INTERVAL n MINUTE)` uses server-side
 * (`floor(epochSeconds / bucketSeconds) * bucketSeconds`), so a grid slot
 * and the SQL row for the same real bucket always carry an identical key to
 * join on.
 */
export async function queryMetricSeries(
  ch: ScopedClickHouse,
  q: MetricSeriesQuery,
): Promise<MetricSeriesResult> {
  const { bucketMinutes, points: numPoints } = RANGES[q.range];
  const bucketSeconds = bucketMinutes * 60;

  if (!VALID_AGGS[q.type].includes(q.agg)) {
    throw new Error(`invalid aggregation "${q.agg}" for metric "${q.metric}" (type "${q.type}")`);
  }

  const nowFlooredS = Math.floor(Date.now() / 1000 / bucketSeconds) * bucketSeconds;
  const grid = Array.from(
    { length: numPoints },
    (_, i) => nowFlooredS - (numPoints - 1 - i) * bucketSeconds,
  );
  const sinceS = grid[0];
  const untilS = nowFlooredS + bucketSeconds; // exclusive upper bound; captures the current, possibly-partial bucket

  const filterEntries = Object.entries(q.filters);
  const params: Record<string, unknown> = {
    metric: q.metric,
    type: q.type,
    bucket_minutes: bucketMinutes,
    since_s: sinceS,
    until_s: untilS,
  };
  if (q.groupBy !== null) params.group_by = q.groupBy;
  filterEntries.forEach(([key, value], i) => {
    params[`f${i}k`] = key;
    params[`f${i}v`] = value;
  });

  const rows = await ch.queryRows<RollupRow>(
    seriesSql(filterEntries.length, q.groupBy !== null),
    params,
  );

  // Rank groups by point count — "top 10 groups by point count", D363 §0.
  // Ungrouped queries have exactly one synthetic group (`grp === ""`), which
  // always wins trivially. No synthetic "other" bucket (D13): groups past 10
  // are dropped, not folded together.
  const byGroup = new Map<string, RollupRow[]>();
  for (const row of rows) {
    const bucket = byGroup.get(row.grp);
    if (bucket) bucket.push(row);
    else byGroup.set(row.grp, [row]);
  }
  const topGroups = [...byGroup.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, 10);
  // The ungrouped view names ONE series for the metric as a whole: a filter
  // combination that matches nothing still renders that series, honestly
  // empty (every point null), rather than vanishing. A grouped view has no
  // such "the metric as a whole" fallback — zero groups matched is zero
  // groups, full stop.
  if (q.groupBy === null && topGroups.length === 0) topGroups.push(["", []]);

  const series = topGroups.map(([grp, groupRows]) => {
    const byBucket = new Map(groupRows.map((row) => [row.bucket_epoch_s, row]));
    const seriesPoints: MetricSeriesPoint[] = grid.map((epochS) => {
      const row = byBucket.get(epochS);
      return { t: hhmmUtc(epochS), v: row ? pointValue(q.type, q.agg, row, bucketSeconds) : null };
    });
    return { group: q.groupBy === null ? null : grp, points: seriesPoints };
  });
  // D381: `totalGroups` is the PRE-truncation distinct-group count —
  // `byGroup.size` before the `.slice(0, 10)` above discarded the rest.
  // Ungrouped queries have no such "N groups" concept, so it mirrors
  // `series.length` there instead — always exactly 1, since the fallback
  // above guarantees the one "metric as a whole" series exists.
  const totalGroups = q.groupBy === null ? series.length : byGroup.size;
  return { series, totalGroups };
}
