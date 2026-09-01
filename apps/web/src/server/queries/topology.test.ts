import assert from "node:assert/strict";
import test from "node:test";
import { layerOrder } from "@/lib/layers";
import { NODE_CAP, WINDOW_HOURS, WINDOW_MINUTES } from "@/lib/topology-types";
import { forWorkspace } from "@/server/clickhouse";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { queryTopology } from "./topology";

// run with: npm test --workspace apps/web -- topology
//
// Hermetic (D96/D113), the metrics.test.ts pair to
// topology.integration.test.ts: nothing here needs a live ClickHouse. What a
// fake `ScopedClickHouse` CAN prove is what the query layer sends and how it
// maps what comes back; what the SQL actually computes is the seeded half's.

// ---- unscoped-SQL tripwire, proven red for this module's table -------------
//
// `runScoped` (clickhouse.ts) is the ONE mechanism, already proven generically
// in tenancy.test.ts; this proves it still bites for the statements this
// module introduces over `obstack.spans`.

test("tripwire: a bare SELECT against obstack.spans is refused before any query runs", async () => {
  const ch = forWorkspace("ws_topology_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT service, count() FROM obstack.spans GROUP BY service"),
    /refusing unscoped SQL/,
  );
});

// ---- what the query layer sends (D113: no query names a workspace) ---------

type Call = { sql: string; params: Record<string, unknown> };

function recorder(rowsFor: (sql: string) => unknown[]): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return rowsFor(sql) as Row[];
      },
    },
  };
}

const isEdgeSql = (sql: string) => sql.includes("INNER JOIN");

const nodeRow = (over: Record<string, unknown> = {}) => ({
  service: "gateway",
  spans: "1440",
  error_spans: "0",
  p95_ms: 12,
  is_entry: 1,
  layer: "api",
  total_services: "2",
  ...over,
});

test("both reads are scoped, bounded to the one 24h window, and name no workspace of their own", async () => {
  const { ch, calls } = recorder(() => []);
  await queryTopology(ch);

  assert.equal(calls.length, 2, "the map is two reads: nodes and edges");
  for (const call of calls) {
    assert.ok(call.sql.includes("{workspace_id:"), "a statement carried no workspace placeholder");
    assert.ok(
      !("workspace_id" in call.params),
      "the scope is the only thing allowed to bind a workspace_id (D113)",
    );
    assert.ok(
      call.sql.includes("toIntervalHour({window_hours:UInt32})"),
      "every read is bounded by the contract's window, bound as a parameter",
    );
    assert.equal(call.params.window_hours, WINDOW_HOURS, "the bound window is the contract's 24h");
    assert.ok(!call.sql.includes("FINAL"), "spans is a plain MergeTree — nothing here may use FINAL");
  }
});

// D403: `runScoped`'s tripwire is satisfied by ONE `{workspace_id:` in the
// statement, so a self-join carrying the predicate on the child side alone
// passes the runtime guard and still matches another tenant's parent span. No
// runtime mechanism can catch that; this SQL-text assertion and the seeded
// cross-tenant probe in topology.integration.test.ts are what do.
test("D403: BOTH sides of the self-join carry the workspace predicate", async () => {
  const { ch, calls } = recorder(() => []);
  await queryTopology(ch);

  const edges = calls.find((c) => isEdgeSql(c.sql));
  assert.ok(edges, "no self-join statement was issued");
  assert.equal(
    (edges.sql.match(/\{workspace_id:/g) ?? []).length,
    2,
    "one occurrence satisfies runScoped's tripwire while the other join side reads every tenant (D403)",
  );
  assert.equal(
    (edges.sql.match(/toIntervalHour\(\{window_hours:UInt32\}\)/g) ?? []).length,
    2,
    "both join sides must also be bounded to the window",
  );
  assert.ok(
    edges.sql.includes("c.service != p.service"),
    "an edge is a call between DIFFERENT services",
  );
  assert.ok(
    edges.sql.includes("c.parent_span_id = p.span_id") && edges.sql.includes("c.trace_id = p.trace_id"),
    "the join is parent/child within one trace",
  );
});

test("the node read caps at NODE_CAP by span count and asks the engine for the pre-cap total", async () => {
  const { ch, calls } = recorder(() => []);
  await queryTopology(ch);
  const nodes = calls.find((c) => !isEdgeSql(c.sql));
  assert.ok(nodes);
  assert.ok(nodes.sql.includes("LIMIT {node_cap:UInt32}"), "the cap is bound, never interpolated");
  assert.equal(nodes.params.node_cap, NODE_CAP);
  assert.ok(nodes.sql.includes("ORDER BY count() DESC"), "the cap ranks by span volume (D402)");
  assert.ok(nodes.sql.includes("count() OVER ()"), "the banner's N is computed in the same query");
  assert.deepEqual(
    nodes.params.layer_order,
    layerOrder,
    "the layer tie-break reads lib/layers.ts rather than restating the order in SQL",
  );
});

// ---- how the rows are mapped (D396's arithmetic) ---------------------------

test("rows map to the contract exactly: rates over the window, the child's error rate on the edge", async () => {
  const { ch } = recorder((sql) =>
    isEdgeSql(sql)
      ? [{ from_service: "gateway", to_service: "agent", calls: "720", error_calls: "72" }]
      : [
          nodeRow({ service: "gateway", spans: "1440", error_spans: "144", p95_ms: 328, is_entry: 1 }),
          nodeRow({ service: "agent", spans: "720", error_spans: "0", p95_ms: 40, is_entry: 0, layer: "agent" }),
        ],
  );

  const topology = await queryTopology(ch);

  assert.deepEqual(topology.nodes, [
    {
      service: "gateway",
      layer: "api",
      spans: 1440,
      spansPerMin: 1440 / WINDOW_MINUTES,
      errorPct: 10,
      p95Ms: 328,
      isEntry: true,
    },
    {
      service: "agent",
      layer: "agent",
      spans: 720,
      spansPerMin: 720 / WINDOW_MINUTES,
      errorPct: 0,
      p95Ms: 40,
      isEntry: false,
    },
  ]);
  assert.deepEqual(topology.edges, [
    { from: "gateway", to: "agent", calls: 720, callsPerMin: 720 / WINDOW_MINUTES, errorPct: 10 },
  ]);
  assert.equal(topology.nodeCap, NODE_CAP);
});

test("totalServices is the engine's pre-cap count, never the number of rows that survived it", async () => {
  const { ch } = recorder((sql) =>
    isEdgeSql(sql) ? [] : [nodeRow({ service: "a", total_services: "77" }), nodeRow({ service: "b", total_services: "77" })],
  );
  const topology = await queryTopology(ch);
  assert.equal(topology.totalServices, 77);
  assert.equal(topology.nodes.length, 2);
});

test("an edge naming a service the cap dropped is not drawn (D396: edges are between rendered nodes)", async () => {
  const { ch } = recorder((sql) =>
    isEdgeSql(sql)
      ? [
          { from_service: "gateway", to_service: "agent", calls: "10", error_calls: "0" },
          { from_service: "gateway", to_service: "capped-out", calls: "9", error_calls: "9" },
          { from_service: "capped-out", to_service: "agent", calls: "8", error_calls: "0" },
        ]
      : [nodeRow({ service: "gateway" }), nodeRow({ service: "agent", layer: "agent" })],
  );
  const topology = await queryTopology(ch);
  assert.deepEqual(
    topology.edges.map((e) => `${e.from}->${e.to}`),
    ["gateway->agent"],
  );
});

test("a workspace that has sent nothing answers empty, never a fabricated node", async () => {
  const { ch } = recorder(() => []);
  assert.deepEqual(await queryTopology(ch), {
    nodes: [],
    edges: [],
    totalServices: 0,
    nodeCap: NODE_CAP,
  });
});
