/**
 * The dashboards contract (S6.3, D426) — CLIENT-SAFE like `metrics-types.ts`
 * (D366): type-only imports, plain data constants, no server module. The
 * stored shape of `dashboards.widgets` (JSONB) is exactly `DashboardWidget[]`,
 * ordered (position = index). Frozen: edits return to the advisor.
 */
import type { MetricAgg, MetricCatalogEntry, MetricRange, MetricSeriesResult } from "./metrics-types";

/** The four mocked kinds — the §5 fence. A fifth is a new sprint, not a new entry. */
export const WIDGET_KINDS = ["timeseries", "stat", "topn", "table"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** The contract's three ranges as a runtime list for validation; the type stays in metrics-types. */
export const METRIC_RANGES: readonly MetricRange[] = ["1h", "6h", "24h"];

/** D402 caps — each is stated on the surface when reached (D430 sentences). */
export const MAX_DASHBOARDS = 50;
export const MAX_WIDGETS_PER_DASHBOARD = 12;
export const MAX_PINNED_WIDGETS = 8;
export const MAX_NAME_CHARS = 80;

export interface DashboardWidget {
  /** App-generated (D116), `wdg_<16 hex>`. */
  id: string;
  /** Trimmed, 1..MAX_NAME_CHARS. */
  title: string;
  kind: WidgetKind;
  metric: string;
  type: MetricCatalogEntry["type"];
  /** Must be in VALID_AGGS[type] (D390). */
  agg: MetricAgg;
  range: MetricRange;
  /** stat => null; topn/table => non-null attr key; timeseries => either. */
  groupBy: string | null;
  /** true => rendered on /app's overview watch (D425). */
  pinned: boolean;
}

export interface Dashboard {
  /** App-generated (D116), `dash_<16 hex>`. */
  id: string;
  name: string;
  widgets: DashboardWidget[];
  /** ISO UTC, bumped by every mutation. */
  updatedAt: string;
}

/** What a widget mutation carries: everything but the id the store assigns. */
export type NewDashboardWidget = Omit<DashboardWidget, "id">;

/** One widget's metrics read with its failure isolated (D428): the CARD says "couldn't load this widget", never the page. */
export type WidgetLoad = { ok: true; result: MetricSeriesResult } | { ok: false };

/** A pinned widget with its home, for the overview (D425). */
export interface PinnedWidget {
  dashboardId: string;
  dashboardName: string;
  widget: DashboardWidget;
}

/**
 * Every dashboard server action's answer (D429/D430): the fresh row as the store
 * holds it, or the refusal sentence the UI prints verbatim. `null` = no
 * workspace to act in (mock mode or no session — the saved-views posture).
 */
export type DashboardActionResult = { dashboard: Dashboard } | { refused: string } | null;
