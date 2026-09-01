/**
 * Where each service sits on the live map (D396) — a pure function of the
 * topology's SHAPE, never of its traffic.
 *
 * A column per layer PRESENT in the topology, in `layerOrder` order, rows by
 * service name in codepoint order, and nothing else:
 * `position = f(layer-rank among the layers present, name-rank)`. That is what
 * makes the map readable across refreshes — a service keeps its lane while its
 * span count, error rate and latency move underneath it, and two renders of the
 * same services produce the same picture on every machine (plain `<`, never
 * `localeCompare`, whose order depends on the runtime's locale data).
 *
 * The columns are COMPACT (D408): `layerOrder` is the ordering, not the
 * indexing, so a workspace of api and infra services draws two ADJACENT
 * columns rather than columns 0 and 4 with ~970 viewBox units of dead space
 * between them. The price is that the workspace's first `tool` span inserts a
 * column and shifts the layers after it one place right — but that is the
 * topology's shape changing, which is the one thing this layout is a function
 * of, and it is paid once when the layer appears rather than on any refresh.
 */

import { layerOrder } from "./layers";
import type { Layer } from "./types";

/** The node box the live map draws; the layout owns the size because it owns the spacing. */
export const NODE_W = 180;
export const NODE_H = 56;

const COL_GAP = 62;
const ROW_GAP = 22;
const MARGIN = 16;

export interface NodePosition {
  /** Top-left of the node box, in viewBox units. */
  x: number;
  y: number;
}

export interface MapLayout {
  /** Keyed by service name; every input node gets exactly one entry. */
  positions: Map<string, NodePosition>;
  /** viewBox size covering every placed box plus the margin; 0 × 0 when there is nothing to place. */
  width: number;
  height: number;
}

export function mapLayout(nodes: readonly { service: string; layer: Layer }[]): MapLayout {
  const positions = new Map<string, NodePosition>();
  let right = 0;
  let bottom = 0;

  const present = new Set(nodes.map((n) => n.layer));
  const columns = layerOrder.filter((layer) => present.has(layer));

  columns.forEach((layer, column) => {
    const services = nodes
      .filter((n) => n.layer === layer)
      .map((n) => n.service)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    services.forEach((service, rank) => {
      const x = MARGIN + column * (NODE_W + COL_GAP);
      const y = MARGIN + rank * (NODE_H + ROW_GAP);
      positions.set(service, { x, y });
      right = Math.max(right, x + NODE_W);
      bottom = Math.max(bottom, y + NODE_H);
    });
  });

  if (positions.size === 0) return { positions, width: 0, height: 0 };
  return { positions, width: right + MARGIN, height: bottom + MARGIN };
}
