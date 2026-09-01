/**
 * The frozen service-map contract (D396, location per D366).
 *
 * Client-safe by the same rule as `metrics-types.ts`: `server/queries/
 * topology.ts` is `server-only` (it holds the SQL and a `ScopedClickHouse`),
 * and anything that renders a topology needs these shapes without dragging the
 * query layer along. One type-only import, no runtime dependency.
 */

import type { Layer } from "./types";

/**
 * The ONE window every S6.2 aggregate surface renders (D394): no range
 * argument, no range picker, stated in words wherever the numbers are. The
 * per-minute rates below are counts divided by `WINDOW_MINUTES`, so the window
 * and the rate can never drift apart.
 */
export const WINDOW_HOURS = 24;
export const WINDOW_MINUTES = WINDOW_HOURS * 60;

/** D402: the map answers with at most this many services, ranked by span count, and says so. */
export const NODE_CAP = 40;

/** One service that has sent at least one span in the window. */
export interface TopologyNode {
  /** `spans.service` — the identity, never a fabricated id. */
  service: string;
  /** The plurality layer of its spans; ties broken by `layerOrder`. */
  layer: Layer;
  spans: number;
  /** `spans` / `WINDOW_MINUTES`. */
  spansPerMin: number;
  /** error spans ÷ spans × 100. */
  errorPct: number;
  p95Ms: number;
  /** At least one span with no parent in this store — traffic enters here. */
  isEntry: boolean;
}

/**
 * A parent span in one service with a child span in another, same trace. The
 * edge exists only when BOTH spans are stored: an uninstrumented hop between
 * two of these draws nothing, which is why the surface says so rather than
 * inventing a link.
 */
export interface TopologyEdge {
  from: string;
  to: string;
  calls: number;
  /** `calls` / `WINDOW_MINUTES`. */
  callsPerMin: number;
  /** The CHILD's error rate — the callee is what failed. */
  errorPct: number;
}

export interface Topology {
  /** Capped at `nodeCap`, ranked by span count. */
  nodes: TopologyNode[];
  /** Only edges between the rendered nodes. */
  edges: TopologyEdge[];
  /** Distinct services in the window BEFORE the cap — the banner's true N. */
  totalServices: number;
  nodeCap: number;
}

export type TopologyStatus = "ok" | "warn" | "err";

/**
 * ONE threshold pair for live nodes and edges (D396): ok <1%, warn 1–5%,
 * err ≥5%. `ServiceMapMock.tsx` keeps its own constants — the demo's palette
 * is part of the fixture it renders, not of this contract.
 */
export const WARN_ERROR_PCT = 1;
export const ERR_ERROR_PCT = 5;

export function topologyStatus(errorPct: number): TopologyStatus {
  if (errorPct >= ERR_ERROR_PCT) return "err";
  if (errorPct >= WARN_ERROR_PCT) return "warn";
  return "ok";
}
