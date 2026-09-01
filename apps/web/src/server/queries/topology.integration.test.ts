import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { NODE_CAP, WINDOW_MINUTES } from "@/lib/topology-types";
import { forWorkspace } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded half of D396: the SQL is the product here. The plurality layer
// with its `layerOrder` tie-break, the 24h bound, the pre-cap service total and
// — above all — D403's two-sided join predicate are all engine behaviour that a
// mocked `ScopedClickHouse` (topology.test.ts) cannot exercise.
//
// Skips only when no ClickHouse answers; `web.yml`'s D36 skip trap fails the
// job on an unexpected skip, so this file executes on every PR.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = WEB_USER;
process.env.CLICKHOUSE_PASSWORD = WEB_PASSWORD;

const seed = createClient({
  url: CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: INGEST_PASSWORD,
  database: "obstack",
});

async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seed.ping()).success;
  } catch {
    return false;
  }
}

/**
 * Four workspaces of this run's own, never the compose dev default `ws_demo`
 * (traces.integration.test.ts precedent) — the seeding user has no mutation
 * grant, so nothing here can be cleaned up afterwards. `WORKSPACE_B` is the
 * D403 tenant: it holds spans with the SAME trace_id and span_ids as A's.
 * `WORKSPACE_C` is the D402 tenant: one service more than the cap.
 * `WORKSPACE_D` is the D423 tenant: its root span carries no service name.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;
const WORKSPACE_C = `ws_itc_${randomBytes(4).toString("hex")}`;
const WORKSPACE_D = `ws_itd_${randomBytes(4).toString("hex")}`;

const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` — mirrors traces.integration.test.ts's `chTimestamp`. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

const NOW_NS = BigInt(Date.now()) * NS_PER_MS;
const minutesAgo = (m: number) => chTimestamp(NOW_NS - BigInt(m) * BigInt(60) * NS_PER_SECOND);

/** One span row with the house defaults for every column a given probe does not care about. */
function spanRow(over: {
  workspace_id: string;
  trace_id: string;
  span_id: string;
  service: string;
  start_time: string;
  parent_span_id?: string;
  layer?: string;
  status_code?: string;
  duration_ns?: string;
  name?: string;
}) {
  return {
    parent_span_id: "",
    name: "POST /chat",
    kind: "server",
    status_code: "ok",
    status_message: "",
    layer: "api",
    duration_ns: "100000000", // 100ms
    gen_ai_system: "",
    gen_ai_request_model: "",
    gen_ai_response_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    finish_reason: "",
    prompt: "",
    completion: "",
    k8s_namespace: "",
    k8s_pod: "",
    k8s_container: "",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
    ...over,
  };
}

/**
 * The fixture, seeded once for every probe below.
 *
 * Workspace A, one trace: `topo-gateway` (root) → `topo-agent` twice, one of
 * those failing, plus a `topo-agent` → `topo-agent` parent/child pair that must
 * NOT become an edge. `topo-mixed` and `topo-plural` exist only to pin the
 * layer rule. `topo-stale`/`topo-ancient` are 25h old — outside the window, and
 * linked to each other so their absence proves the bound on BOTH reads.
 *
 * Workspace B holds the SAME trace_id and the SAME span_ids under its own
 * service names: a join side that forgot its workspace predicate would cross
 * the two and draw an edge between a service from each (D403).
 */
const TRACE = randomBytes(8).toString("hex");
const STALE_TRACE = randomBytes(8).toString("hex");
const GATEWAY_SPAN = randomBytes(4).toString("hex");
const AGENT_SPAN = randomBytes(4).toString("hex");
const ms = (n: number) => String(n * 1_000_000);

/**
 * D402's tenant: `NODE_CAP + 1` services, one span each. This is the only shape
 * that tells a PRE-LIMIT `count() OVER ()` from a post-LIMIT one — post-LIMIT
 * the total would equal the rows the cap left, `totalServices > nodeCap` would
 * never hold, and a workspace running 200 services would be shown 40 of them
 * with no banner saying so. Every service ties at one span, so `service ASC`
 * decides which one is dropped: the last name.
 */
const CAP_TRACE = randomBytes(8).toString("hex");
const CAP_SERVICES = Array.from(
  { length: NODE_CAP + 1 },
  (_, i) => `topo-cap-${String(i).padStart(2, "0")}`,
);

const FIXTURE = [
  // --- workspace A, inside the window ---
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: GATEWAY_SPAN,
    service: "topo-gateway",
    layer: "api",
    start_time: minutesAgo(10),
    duration_ns: ms(300),
  }),
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: AGENT_SPAN,
    parent_span_id: GATEWAY_SPAN,
    service: "topo-agent",
    layer: "agent",
    status_code: "error",
    start_time: minutesAgo(10),
    duration_ns: ms(200),
  }),
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: `${AGENT_SPAN.slice(0, 6)}a2`,
    parent_span_id: GATEWAY_SPAN,
    service: "topo-agent",
    layer: "agent",
    start_time: minutesAgo(10),
    duration_ns: ms(200),
  }),
  // same service on both sides of a parent/child link -> never an edge
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: `${AGENT_SPAN.slice(0, 6)}a3`,
    parent_span_id: AGENT_SPAN,
    service: "topo-agent",
    layer: "agent",
    start_time: minutesAgo(10),
    duration_ns: ms(200),
  }),
  // a tie on span count: `tool` precedes `llm` in layerOrder, so `tool` wins
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: `${AGENT_SPAN.slice(0, 6)}m1`,
    parent_span_id: "",
    service: "topo-mixed",
    layer: "llm",
    start_time: minutesAgo(10),
  }),
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: `${AGENT_SPAN.slice(0, 6)}m2`,
    parent_span_id: "",
    service: "topo-mixed",
    layer: "tool",
    start_time: minutesAgo(10),
  }),
  // plurality beats layerOrder: two `llm` spans against one `api` span
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: `${AGENT_SPAN.slice(0, 6)}p1`,
    parent_span_id: "",
    service: "topo-plural",
    layer: "api",
    start_time: minutesAgo(10),
  }),
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: `${AGENT_SPAN.slice(0, 6)}p2`,
    parent_span_id: "",
    service: "topo-plural",
    layer: "llm",
    start_time: minutesAgo(10),
  }),
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: TRACE,
    span_id: `${AGENT_SPAN.slice(0, 6)}p3`,
    parent_span_id: "",
    service: "topo-plural",
    layer: "llm",
    start_time: minutesAgo(10),
  }),

  // --- workspace A, 25h old: outside the window on BOTH reads ---
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: STALE_TRACE,
    span_id: `${GATEWAY_SPAN.slice(0, 6)}s1`,
    service: "topo-stale",
    layer: "api",
    start_time: minutesAgo(25 * 60),
  }),
  spanRow({
    workspace_id: WORKSPACE_ID,
    trace_id: STALE_TRACE,
    span_id: `${GATEWAY_SPAN.slice(0, 6)}s2`,
    parent_span_id: `${GATEWAY_SPAN.slice(0, 6)}s1`,
    service: "topo-ancient",
    layer: "agent",
    start_time: minutesAgo(25 * 60),
  }),

  // --- workspace B: the SAME trace_id, the SAME span_ids, the SAME service
  // names (D403). Two tenants both running a service called "gateway" is the
  // ordinary case, and it is the one that makes a leak observable: a join side
  // that forgot its workspace predicate does not draw a foreign NAME (the
  // "edges between rendered nodes" rule would hide that one) — it inflates this
  // workspace's own counts with the other tenant's calls.
  spanRow({
    workspace_id: WORKSPACE_B,
    trace_id: TRACE,
    span_id: GATEWAY_SPAN,
    service: "topo-gateway",
    layer: "api",
    start_time: minutesAgo(10),
  }),
  spanRow({
    workspace_id: WORKSPACE_B,
    trace_id: TRACE,
    span_id: AGENT_SPAN,
    parent_span_id: GATEWAY_SPAN,
    service: "topo-agent",
    layer: "agent",
    start_time: minutesAgo(10),
  }),
  // ... plus one service only B runs, so "A sees none of B" is also nameable.
  spanRow({
    workspace_id: WORKSPACE_B,
    trace_id: TRACE,
    span_id: `${GATEWAY_SPAN.slice(0, 6)}b3`,
    service: "topo-b-only",
    layer: "tool",
    start_time: minutesAgo(10),
  }),

  // --- workspace C: one service more than the cap ---
  ...CAP_SERVICES.map((service, i) =>
    spanRow({
      workspace_id: WORKSPACE_C,
      trace_id: CAP_TRACE,
      span_id: `${GATEWAY_SPAN.slice(0, 4)}c${String(i).padStart(2, "0")}`,
      service,
      start_time: minutesAgo(10),
    }),
  ),

  // --- workspace D: a root span carrying no `service.name`, and its named
  // child (D423). Its own tenant on purpose: dropped into workspace A the child
  // would have moved a layer count the probes above pin.
  spanRow({
    workspace_id: WORKSPACE_D,
    trace_id: TRACE,
    span_id: `${GATEWAY_SPAN.slice(0, 6)}d1`,
    service: "",
    start_time: minutesAgo(10),
  }),
  spanRow({
    workspace_id: WORKSPACE_D,
    trace_id: TRACE,
    span_id: `${GATEWAY_SPAN.slice(0, 6)}d2`,
    parent_span_id: `${GATEWAY_SPAN.slice(0, 6)}d1`,
    service: "topo-named",
    start_time: minutesAgo(10),
  }),
];

test("the span topology (D396) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { queryTopology } = await import("./topology");
  await seed.insert({ table: "spans", format: "JSONEachRow", values: FIXTURE });

  const topology = await queryTopology(forWorkspace(WORKSPACE_ID));
  const node = (service: string) => topology.nodes.find((n) => n.service === service);

  await t.test("a node per service that sent a span, with its rates over the window", () => {
    assert.deepEqual(
      [...topology.nodes.map((n) => n.service)].sort(),
      ["topo-agent", "topo-gateway", "topo-mixed", "topo-plural"],
      "the node set is the window's services — no more, no fewer",
    );
    assert.deepEqual(node("topo-gateway"), {
      service: "topo-gateway",
      layer: "api",
      spans: 1,
      spansPerMin: 1 / WINDOW_MINUTES,
      errorPct: 0,
      p95Ms: 300,
      isEntry: true,
    });
    const agent = node("topo-agent")!;
    assert.equal(agent.spans, 3);
    assert.equal(agent.p95Ms, 200, "every agent span ran 200ms, so p95 is exactly 200");
    assert.equal(agent.errorPct.toFixed(2), (100 / 3).toFixed(2), "1 error span in 3");
    assert.equal(agent.isEntry, false, "every agent span has a parent — it is not an entry point");
  });

  await t.test("the layer is the plurality of the service's spans, ties broken by layerOrder", () => {
    assert.equal(node("topo-plural")!.layer, "llm", "two llm spans beat one api span");
    assert.equal(node("topo-mixed")!.layer, "tool", "one llm and one tool tie; tool precedes llm in layerOrder");
  });

  await t.test("an edge is a cross-service parent/child in one trace, carrying the child's error rate", () => {
    assert.deepEqual(topology.edges, [
      {
        from: "topo-gateway",
        to: "topo-agent",
        calls: 2,
        callsPerMin: 2 / WINDOW_MINUTES,
        errorPct: 50,
      },
    ]);
  });

  await t.test("a parent/child pair inside ONE service draws no edge", () => {
    assert.equal(
      topology.edges.some((e) => e.from === e.to),
      false,
      "topo-agent -> topo-agent is a call the map must not invent a hop for",
    );
  });

  await t.test("a 25h-old span is outside the window — no node, and no edge either", () => {
    assert.equal(node("topo-stale"), undefined);
    assert.equal(node("topo-ancient"), undefined);
    assert.equal(
      topology.edges.some((e) => e.from === "topo-stale" || e.to === "topo-ancient"),
      false,
      "the linked 25h-old pair must not survive the edge read's bound",
    );
  });

  await t.test("totalServices counts the window's services, and nodeCap states the cap applied", () => {
    assert.equal(topology.totalServices, 4);
    assert.equal(topology.nodeCap, 40);
  });

  // D423(a): a span with no `service.name` does not name a service — the rule
  // `trace_summaries_mv` already applies, now applied to the map. NODES_SQL's
  // `service != ''` is the load-bearing half: without it this tenant reports a
  // nameless node and a totalServices of 2 that `/app/services` disagrees with.
  // The absent edge is over-determined — the edge read's own `service != ''`
  // drops the unnamed parent before the join, AND `queryTopology` draws edges
  // only between RENDERED nodes — so removing either edge-side predicate alone
  // leaves this green.
  await t.test("a span with no service name is not a service: no node, no edge, no place in the total", async () => {
    const unnamed = await queryTopology(forWorkspace(WORKSPACE_D));
    assert.deepEqual(
      unnamed.nodes.map((n) => n.service),
      ["topo-named"],
      "the unnamed root is not a node; its named child is",
    );
    assert.deepEqual(unnamed.edges, [], "no hop is drawn out of a service the map will not name");
    assert.equal(unnamed.totalServices, 1, "the D402 banner counts named services only");
  });

  // D402: the banner's N is the engine's, computed in the same statement. Under
  // the cap the two numbers are equal and prove nothing — this is the tenant
  // where they differ.
  await t.test("over the cap: NODE_CAP nodes by span volume, and a total that still counts them all", async () => {
    const capped = await queryTopology(forWorkspace(WORKSPACE_C));
    assert.equal(capped.nodes.length, NODE_CAP, "the cap is applied by the engine, not by the caller");
    assert.equal(
      capped.totalServices,
      NODE_CAP + 1,
      "count() OVER () must count the window's services, never the rows the LIMIT left",
    );
    assert.equal(
      capped.nodes.some((n) => n.service === CAP_SERVICES[NODE_CAP]),
      false,
      "every service ties at one span, so the ORDER BY's `service ASC` drops the last name",
    );
  });

  // D403: the leak class this module could reintroduce. Workspace B holds the
  // same (trace_id, span_id) pair under the same service names, so an unscoped
  // PARENT side gives A's two children a second parent to match (calls 4, not
  // 2) and an unscoped CHILD side hands A workspace B's call as well (calls 3,
  // error rate 33%, not 2 and 50%). Both are proven by the numbers asserted
  // above and below, and neither can hide behind the rendered-nodes filter.
  await t.test("no join side crosses tenants, though both hold the same trace_id, span_ids and service names", async () => {
    assert.equal(
      topology.nodes.some((n) => n.service === "topo-b-only"),
      false,
      "workspace A read a service only workspace B runs",
    );

    const other = await queryTopology(forWorkspace(WORKSPACE_B));
    assert.deepEqual(
      other.nodes.map((n) => n.service).sort(),
      ["topo-agent", "topo-b-only", "topo-gateway"],
      "workspace B must see its own three services and nothing of A's",
    );
    assert.equal(other.nodes.find((n) => n.service === "topo-agent")!.spans, 1, "A's 3 agent spans are not B's");
    // Control: B's own cross-service hop DOES resolve — the counts above are a
    // scoped read, not a join that happens to match nothing.
    assert.deepEqual(other.edges, [
      {
        from: "topo-gateway",
        to: "topo-agent",
        calls: 1,
        callsPerMin: 1 / WINDOW_MINUTES,
        errorPct: 0,
      },
    ]);
  });
});
