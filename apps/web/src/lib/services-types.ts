import type { Layer } from "./types";

/**
 * The trace-derived service contract (D397, location per D366).
 *
 * CLIENT-SAFE by design, like `lib/metrics-types.ts`: `server/queries/
 * services.ts` is `server-only` (real SQL, a `ScopedClickHouse`), but the
 * components that render its answers need the shapes to type their props.
 * Nothing here reaches for the server: one type import, the window and cap
 * constants, and the shapes. `spansPerMin` is rendered by `fmtPerMin` in
 * `lib/format.ts`, with every other number this app prints (D409).
 *
 * Everything below is derived from spans the workspace actually sent. The
 * fixture catalog's `team`, `tier`, `runtime`, `sloStatus`, `score.*`, `grade`
 * and `deps` have NO trace-derived counterpart, so they are absent rather than
 * zeroed (D13) — and the dependency answer belongs to the service map, one
 * derivation, not two (D393).
 */

/**
 * The ONE window every aggregate surface renders (D394). There is no range
 * argument and no range picker: `server/queries/services.ts` binds this, and
 * the components state it in words. 24h is the ceiling this sprint (D395) —
 * 7d needs a rollup, and a rollup is DDL.
 */
export const WINDOW_HOURS = 24;

/** D402: the catalog's GROUP BY is unbounded, so it ships a cap and says so. */
export const SERVICE_CAP = 100;

/** Same rule for the detail's two GROUP BYs — span names are as unbounded as services are. */
export const TOP_SPAN_NAME_CAP = 10;

/** The detail's error-trace list is capped by recency, not by a ranking. */
export const RECENT_ERROR_TRACE_CAP = 10;

/** One row of the trace-derived catalog. */
export interface ServiceRow {
  /** `spans.service` — the identity, and the URL segment of the detail page. */
  name: string;
  /** The layer most of this service's spans carry; ties by `layerOrder` (D396). */
  layer: Layer;
  /** Spans in the window. */
  spans: number;
  /** `spans / (WINDOW_HOURS * 60)` — the window's average, not a live rate. */
  spansPerMin: number;
  /** Error spans ÷ spans × 100. */
  errorPct: number;
  p50Ms: number;
  p95Ms: number;
  /** Summed `cost_usd` over the window's spans. */
  costUsd: number;
  /** Distinct gen_ai request/response models seen on this service's spans. */
  models: string[];
  /** ISO UTC minute of the most recent span, e.g. "2026-09-01T09:30Z". */
  lastSeenAt: string;
}

/** One service's page: its catalog row plus the two reads only the detail needs. */
export interface ServiceDetail extends ServiceRow {
  /** Top span names by count, capped at `TOP_SPAN_NAME_CAP`. */
  topSpanNames: { name: string; count: number; errorPct: number }[];
  /** Pre-cap distinct span names, so the panel can say "showing N of M". */
  totalSpanNames: number;
  /**
   * The most recent traces this service took part in that carry at least one
   * error span — from `trace_summaries`, so the error may belong to another
   * service of the same trace. The surface says so.
   */
  recentErrorTraces: { traceId: string; rootName: string; startedAt: string }[];
}

/** The catalog page's answer: the capped rows and the true total behind them (D402). */
export interface ServiceList {
  rows: ServiceRow[];
  /** Distinct services with a span in the window, BEFORE `SERVICE_CAP` truncated the list. */
  totalServices: number;
}
