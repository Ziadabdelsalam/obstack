import "server-only";
import { layerOrder } from "@/lib/layers";
import {
  NODE_CAP,
  WINDOW_HOURS,
  WINDOW_MINUTES,
  type Topology,
  type TopologyEdge,
  type TopologyNode,
} from "@/lib/topology-types";
import type { Layer } from "@/lib/types";
import type { ScopedClickHouse } from "@/server/clickhouse";

/** A span carrying no `service.name` does not name a service — the `trace_summaries_mv`'s own rule (`groupUniqArrayIf(toString(service), service != '')`), applied to the map (D423). */
const NAMED_SERVICE = "service != ''";

/**
 * The service map's two reads over `obstack.spans` (D396). No range argument
 * (D394): the window is `WINDOW_HOURS`, bound as a parameter so the surface and
 * the query cannot state different windows.
 *
 * The plurality layer is computed IN SQL from the layer counts of the service's
 * own spans, with `layerOrder` bound as an array parameter rather than restated
 * here — `lib/layers.ts` stays the one definition of that order, and the tie
 * rule ("plurality, then `layerOrder`") is one `arraySort` key: `-count` first,
 * then the layer's position in the bound array. The `sumMap` expression appears
 * twice because a SELECT-list alias is not visible to a sibling expression on
 * this engine (measured on clickhouse-server 26.3.17.110: `Unknown expression
 * or function identifier 'layer_counts'`).
 *
 * `count() OVER ()` is the D402 banner's true N: window functions are evaluated
 * after GROUP BY and before LIMIT, so it counts the services in the window, not
 * the rows that survived the cap (measured on the pinned engine — the same
 * statement at LIMIT 1 and LIMIT 40 reports the same total).
 */
const NODES_SQL = `
SELECT
    service,
    toString(count())                                               AS spans,
    toString(countIf(status_code = 'error'))                        AS error_spans,
    ifNotFinite(quantile(0.95)(duration_ns) / 1e6, 0)               AS p95_ms,
    countIf(parent_span_id = '') > 0                                AS is_entry,
    arraySort(
        x -> (-x.2, indexOf({layer_order:Array(String)}, x.1)),
        arrayZip(
            sumMap([toString(layer)], [toUInt64(1)]).1,
            sumMap([toString(layer)], [toUInt64(1)]).2
        )
    )[1].1                                                          AS layer,
    toString(count() OVER ())                                       AS total_services
FROM obstack.spans
WHERE workspace_id = {workspace_id:String}
  AND start_time >= now() - toIntervalHour({window_hours:UInt32})
  AND ${NAMED_SERVICE}
GROUP BY service
ORDER BY count() DESC, service ASC
LIMIT {node_cap:UInt32}`;

/**
 * The edge read: a parent span and a child span in the SAME trace whose
 * services differ. Both sides are their own scoped subquery, and D403 is why
 * they are written this way — `runScoped`'s tripwire is satisfied by ONE
 * `{workspace_id:` occurrence, so a self-join with only the child side bound
 * would happily match another tenant's parent span carrying the same
 * `(trace_id, span_id)` and draw an edge into a service this workspace has
 * never run. Each side filters to the workspace and the window BEFORE the join;
 * `topology.integration.test.ts` seeds exactly that colliding pair in two
 * workspaces and proves neither sees the other.
 *
 * An INNER join is the contract: an edge exists only when both spans are in the
 * store, so an uninstrumented hop draws nothing rather than a guessed link.
 */
const EDGES_SQL = `
SELECT
    p.service                                  AS from_service,
    c.service                                  AS to_service,
    toString(count())                          AS calls,
    toString(countIf(c.status_code = 'error')) AS error_calls
FROM (
    SELECT trace_id, parent_span_id, service, status_code
    FROM obstack.spans
    WHERE workspace_id = {workspace_id:String}
      AND start_time >= now() - toIntervalHour({window_hours:UInt32})
      AND parent_span_id != ''
      AND ${NAMED_SERVICE}
) AS c
INNER JOIN (
    SELECT trace_id, span_id, service
    FROM obstack.spans
    WHERE workspace_id = {workspace_id:String}
      AND start_time >= now() - toIntervalHour({window_hours:UInt32})
      AND ${NAMED_SERVICE}
) AS p
ON c.trace_id = p.trace_id AND c.parent_span_id = p.span_id
WHERE c.service != p.service
GROUP BY from_service, to_service
ORDER BY count() DESC, from_service ASC, to_service ASC`;

interface NodeRow {
  service: string;
  spans: string;
  error_spans: string;
  p95_ms: number;
  /** UInt8 over the wire. */
  is_entry: number;
  /** `toString` of the `layer` Enum8 — always one of the six `Layer` members. */
  layer: Layer;
  total_services: string;
}

interface EdgeRow {
  from_service: string;
  to_service: string;
  calls: string;
  error_calls: string;
}

const pct = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);

/** The scope is the only parameter (D113/D394): no workspace to name, no range to pass. */
export async function queryTopology(ch: ScopedClickHouse): Promise<Topology> {
  const params = { window_hours: WINDOW_HOURS, node_cap: NODE_CAP, layer_order: layerOrder };
  const [nodeRows, edgeRows] = await Promise.all([
    ch.queryRows<NodeRow>(NODES_SQL, params),
    ch.queryRows<EdgeRow>(EDGES_SQL, params),
  ]);

  const nodes: TopologyNode[] = nodeRows.map((row) => {
    const spans = Number(row.spans);
    return {
      service: row.service,
      layer: row.layer,
      spans,
      spansPerMin: spans / WINDOW_MINUTES,
      errorPct: pct(Number(row.error_spans), spans),
      p95Ms: row.p95_ms,
      isEntry: row.is_entry === 1,
    };
  });

  // D396: the edges shown are those between the services shown. A service the
  // cap dropped takes its edges with it rather than leaving a line to nowhere.
  const rendered = new Set(nodes.map((n) => n.service));
  const edges: TopologyEdge[] = edgeRows
    .filter((row) => rendered.has(row.from_service) && rendered.has(row.to_service))
    .map((row) => {
      const calls = Number(row.calls);
      return {
        from: row.from_service,
        to: row.to_service,
        calls,
        callsPerMin: calls / WINDOW_MINUTES,
        errorPct: pct(Number(row.error_calls), calls),
      };
    });

  return {
    nodes,
    edges,
    // Every row carries the same pre-cap total; with no services at all there is
    // no row to carry it, and the total is 0.
    totalServices: Number(nodeRows[0]?.total_services ?? 0),
    nodeCap: NODE_CAP,
  };
}
