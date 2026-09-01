/**
 * The frozen metrics query-API contract (D363 packet §0, location per D366).
 *
 * These types are CLIENT-SAFE by design: `server/queries/metrics.ts` is
 * `server-only` (it holds real SQL and a `ScopedClickHouse`), but T7's client
 * components still need the shapes it returns to type their props — a client
 * component cannot import a `server-only` module for a type alone (S1.5/D10
 * precedent). This file carries no imports and one plain data constant, so it
 * can be pulled into either side of the server/client boundary.
 */

/** One row of the discovered metric catalog — never fixture-fed. */
export interface MetricCatalogEntry {
  /** OTLP metric name = the identity. */
  name: string;
  type: "gauge" | "sum" | "histogram";
  /** As emitted; "" if none. */
  unit: string;
  /** ISO UTC minute. */
  lastSeen: string;
  /** Observed attribute keys -> the groupBy/filter options the UI offers. */
  attrKeys: string[];
}

/** Widths below; extensible at M6 without a schema change. */
export type MetricRange = "1h" | "6h" | "24h";

/** Validity by type: gauge -> avg|min|max|last; sum -> sum|rate; histogram -> pXX|avg. */
export type MetricAgg = "avg" | "min" | "max" | "last" | "sum" | "rate" | "p50" | "p90" | "p95" | "p99";

/** The one agg-validity table (D390): gauge -> avg|min|max|last; sum -> sum|rate;
 *  histogram -> p50|p90|p95|p99|avg. `server/queries/metrics.ts` enforces it
 *  (an invalid pair is the module's only request error); the explore page
 *  and ExploreLive read it for the deep-link guard and the agg vocabulary,
 *  so the UI can never offer what the server refuses. */
export const VALID_AGGS: Record<MetricCatalogEntry["type"], readonly MetricAgg[]> = {
  gauge: ["avg", "min", "max", "last"],
  sum: ["sum", "rate"],
  histogram: ["p50", "p90", "p95", "p99", "avg"],
};

export interface MetricSeriesQuery {
  metric: string;
  /**
   * D384: REQUIRED — the caller (the catalog entry the UI selected) names the
   * type directly, rather than the query layer inferring/guessing it. This is
   * what makes a D378 dual-emitted name (the same metric name genuinely
   * emitted as two types) answerable at all: `metric` alone cannot disambiguate,
   * "gauge avg" and "histogram avg" are two different, independently correct
   * answers for the same name.
   */
  type: "gauge" | "sum" | "histogram";
  range: MetricRange;
  agg: MetricAgg;
  /** An observed attribute key ("service.name" included) or null. */
  groupBy: string | null;
  /** attrKey -> exact value; the fixture's service/env filters are instances of this. */
  filters: Record<string, string>;
}

/** `v: null` = empty bucket — an honest gap, never 0. */
export interface MetricSeriesPoint {
  t: string;
  v: number | null;
}

export interface MetricSeries {
  group: string | null;
  points: MetricSeriesPoint[];
}

/**
 * D381 (§0 amendment): `totalGroups` is the PRE-truncation distinct-group
 * count — "showing top 10 of N" needs the true N, not `series.length` (which
 * is capped at 10). With `groupBy: null` there is only ever the one
 * ungrouped series naming the metric as a whole, so `totalGroups` equals
 * `series.length`: `queryMetricSeries` always answers an ungrouped query
 * with exactly that one series — honestly empty (every point null) when
 * nothing matched, including for a (name, type) pair the workspace never
 * emitted, rather than vanishing.
 */
export interface MetricSeriesResult {
  series: MetricSeries[];
  totalGroups: number;
}
