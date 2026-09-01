/**
 * Widget rendering as pure, unit-tested data transforms (S6.3, D427/D428) —
 * kept separate from `WidgetLive.tsx` because the client component (recharts)
 * cannot be imported under the `tsx --conditions react-server` test harness.
 * Every observable rule D427 states (the fold per agg, the `n of N` counts,
 * ordering, the D381 truncation caption) lives here so it is provable without
 * a DOM.
 */
import type {
  MetricAgg,
  MetricRange,
  MetricSeriesPoint,
  MetricSeriesQuery,
  MetricSeriesResult,
} from "./metrics-types";
import type { Dashboard, DashboardWidget, PinnedWidget } from "./dashboard-types";

/** Always `filters: {}` (fence 10) — a widget never stores filters. */
export function widgetQuery(w: DashboardWidget): MetricSeriesQuery {
  return { metric: w.metric, type: w.type, range: w.range, agg: w.agg, groupBy: w.groupBy, filters: {} };
}

/** The workspace's pinned widgets, dashboard list order then widget index (D425). */
export function pinnedWidgets(dashboards: Dashboard[]): PinnedWidget[] {
  const result: PinnedWidget[] = [];
  for (const dashboard of dashboards) {
    for (const widget of dashboard.widgets) {
      if (widget.pinned) result.push({ dashboardId: dashboard.id, dashboardName: dashboard.name, widget });
    }
  }
  return result;
}

/**
 * The ONE fold per agg (D427): `sum`/`min`/`max` reduce the non-null values by
 * that name; `last` is the LAST non-null point (not the last bucket — a
 * trailing gap must not read as "no data"); everything else (`avg`, `rate`,
 * `p50`/`p90`/`p95`/`p99`) is the arithmetic mean of the non-null values. `n`
 * of `total` buckets had data; `value`/`t` are `null` when `n === 0`.
 */
export interface Fold {
  kind: "sum" | "min" | "max" | "mean" | "last";
  value: number | null;
  n: number;
  total: number;
  /** The chosen point's own `t` — set only when `kind === "last"` and `value !== null`. */
  t: string | null;
}

function foldKind(agg: MetricAgg): Fold["kind"] {
  if (agg === "sum" || agg === "min" || agg === "max" || agg === "last") return agg;
  return "mean"; // avg, rate, p50, p90, p95, p99
}

export function foldSeries(points: MetricSeriesPoint[], agg: MetricAgg): Fold {
  const kind = foldKind(agg);
  const total = points.length;
  const withData = points.filter((p): p is { t: string; v: number } => p.v !== null);
  const n = withData.length;
  if (n === 0) return { kind, value: null, n: 0, total, t: null };
  if (kind === "last") {
    const last = withData[withData.length - 1];
    return { kind, value: last.v, n, total, t: last.t };
  }
  const values = withData.map((p) => p.v);
  const value =
    kind === "sum"
      ? values.reduce((a, b) => a + b, 0)
      : kind === "min"
        ? Math.min(...values)
        : kind === "max"
          ? Math.max(...values)
          : values.reduce((a, b) => a + b, 0) / n; // mean
  return { kind, value, n, total, t: null };
}

/** The exact caption text D427 prints for a fold, e.g. `sum · last 6h · 4 of 12 buckets had data`. */
export function foldCaption(fold: Fold, range: MetricRange): string {
  if (fold.kind === "last") return `latest · as of ${fold.t} · last ${range}`;
  return `${fold.kind} · last ${range} · ${fold.n} of ${fold.total} buckets had data`;
}

/** Zero series, or every point in every series null — the D436 empty card, no chart. */
export function isEmptyResult(result: MetricSeriesResult): boolean {
  return result.series.length === 0 || result.series.every((s) => s.points.every((p) => p.v === null));
}

/** A stat widget's single series, folded (D427). */
export type StatView = { empty: true } | { empty: false; value: number; caption: string };

export function statView(result: MetricSeriesResult, widget: DashboardWidget): StatView {
  const points = result.series[0]?.points ?? [];
  const fold = foldSeries(points, widget.agg);
  if (fold.value === null) return { empty: true };
  return { empty: false, value: fold.value, caption: foldCaption(fold, widget.range) };
}

/** One row per group for a topn/table widget, folded and ordered by folded value desc, ties by group name. */
export interface GroupRow {
  group: string;
  fold: Fold;
}

export interface GroupRowsView {
  rows: GroupRow[];
  /** D381: the PRE-truncation distinct-group count, passed through untouched. */
  totalGroups: number;
}

export function groupRows(result: MetricSeriesResult, widget: DashboardWidget): GroupRowsView {
  const rows = result.series.map((s) => ({
    group: s.group ?? widget.metric,
    fold: foldSeries(s.points, widget.agg),
  }));
  rows.sort((a, b) => {
    const av = a.fold.value ?? -Infinity;
    const bv = b.fold.value ?? -Infinity;
    if (av !== bv) return bv - av;
    return a.group.localeCompare(b.group);
  });
  return { rows, totalGroups: result.totalGroups };
}

/** D381: `showing {shown} of {totalGroups} groups`, only when the result was actually truncated. */
export function groupsCaption(shown: number, totalGroups: number): string | null {
  return totalGroups > shown ? `showing ${shown} of ${totalGroups} groups` : null;
}
