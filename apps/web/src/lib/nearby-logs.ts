/**
 * The nearby-logs window and cap (D37.4, kickoff Decisions 3-5): trace detail's
 * "nearby" rail is a second read on `(workspace_id, k8s_namespace, k8s_pod)` for
 * a time window around the trace, not a `trace_id` match. Both the nearby query
 * (`server/queries/traces.ts`) and the UI (`TraceExplorer.tsx`) read these same
 * numbers — no more hardcoded "±10s" in prose.
 *
 * Pure data, deliberately outside `src/server/` — the live-routes.ts precedent
 * (D21-AMENDMENT): a client component can import this directly without dragging
 * the query layer in.
 */

/** Seconds either side of the trace's [min_start, max_end] range counted as "nearby" (kickoff Decision 3). */
export const NEARBY_LOG_WINDOW_S = 10;

/** `NEARBY_LOG_WINDOW_S` in nanoseconds, for binding against `obstack.logs.timestamp`. */
export const NEARBY_LOG_WINDOW_NS = NEARBY_LOG_WINDOW_S * 1_000_000_000;

/**
 * Hard cap on nearby rows fetched for one trace (kickoff Decision 5). At the
 * cap the rail's counter carries an explicit truncation marker — it must never
 * claim a row it did not render (D13/D21).
 */
export const NEARBY_LOG_CAP = 200;
