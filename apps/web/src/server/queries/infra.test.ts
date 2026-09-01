import assert from "node:assert/strict";
import test from "node:test";
import {
  CLUSTER_METRICS,
  INFRA_NODE_CAP,
  INFRA_POD_CAP,
  INFRA_RECS_CAP,
  INFRA_RECS_MIN_OBSERVED_HOURS,
  INFRA_RECS_WINDOW_HOURS,
  INFRA_STALE_MINUTES,
  KUBELET_METRICS,
  REC_CPU_NEAR_LIMIT_ABOVE,
  REC_MEMORY_NEAR_LIMIT_ABOVE,
  REC_MEMORY_OVERSIZED_BELOW,
} from "@/lib/infra-types";
import { forWorkspace } from "@/server/clickhouse";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { queryInfraSnapshot } from "./infra";

// run with: npm test --workspace apps/web -- infra
//
// Hermetic (D96/D113), like services.test.ts: nothing here needs a live
// ClickHouse. What the two statements COMPUTE — the merge read, the freshness
// bound, the tenancy — is proven against a seeded server in
// infra.integration.test.ts; this file proves what the module SENDS and what it
// makes of the rows it gets back.

// ---- unscoped-SQL tripwire, proven red per table --------------------------

test("tripwire: a bare SELECT against obstack.metric_points_1m is refused before any query runs", async () => {
  const ch = forWorkspace("ws_infra_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT name, argMaxMerge(gauge_last) FROM obstack.metric_points_1m GROUP BY name"),
    /refusing unscoped SQL/,
  );
});

test("tripwire: a caller-supplied workspace_id is refused, even on a scoped statement", async () => {
  const ch = forWorkspace("ws_infra_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT name FROM obstack.metric_points_1m WHERE workspace_id = {workspace_id:String}", {
      workspace_id: "ws_someone_else",
    }),
    /refusing a caller-supplied workspace_id/,
  );
});

// ---- what the query layer sends (D113: no query names a workspace) --------

type Call = { sql: string; params: Record<string, unknown> };

function recorder(responder: (sql: string) => unknown[]): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return responder(sql) as Row[];
      },
    },
  };
}

/** Statement 2 is the only one that names the 24h window. */
const isWindowCall = (sql: string): boolean => sql.includes("first_bucket_s");

// ---- the fixture: rows shaped exactly as ClickHouse returns them ----------

const NOW_ISO = "2026-09-01T10:00Z";
const EARLIER_ISO = "2026-09-01T09:58Z";

interface Attrs {
  node?: string;
  ns?: string;
  pod?: string;
  container?: string;
}

const attrs = (a: Attrs): Record<string, string> => ({
  ...(a.node === undefined ? {} : { "k8s.node.name": a.node }),
  ...(a.ns === undefined ? {} : { "k8s.namespace.name": a.ns }),
  ...(a.pod === undefined ? {} : { "k8s.pod.name": a.pod }),
  ...(a.container === undefined ? {} : { "k8s.container.name": a.container }),
});

const fresh = (name: string, value: number, a: Attrs, iso = NOW_ISO) => ({
  name,
  value,
  attributes: attrs(a),
  last_seen_iso: iso,
});

const HOUR_S = 3600;
const windowRow = (name: string, peak: number, a: Attrs, hours: number) => ({
  name,
  attributes: attrs(a),
  peak,
  first_bucket_s: 1_800_000_000,
  last_bucket_s: 1_800_000_000 + Math.round(hours * HOUR_S),
});

/**
 * One node with a full cluster+kubelet reading and one pod on it; the pod's
 * single container is limited at 512MiB and peaks at 100MiB over 20 observed
 * hours, which is the ruled `memory-limit-oversized` shape (D458).
 */
const FRESH_ROWS = [
  fresh("k8s.node.cpu.usage", 1.2, { node: "node-a" }),
  fresh("k8s.node.memory.working_set", 6_442_450_944, { node: "node-a" }),
  fresh("k8s.node.memory.available", 10_737_418_240, { node: "node-a" }, EARLIER_ISO),
  fresh("k8s.node.allocatable_cpu", 4, { node: "node-a" }),
  fresh("k8s.node.allocatable_memory", 17_179_869_184, { node: "node-a" }),
  fresh("k8s.node.condition_ready", 1, { node: "node-a" }),
  fresh("k8s.node.condition_memory_pressure", 0, { node: "node-a" }),
  fresh("k8s.pod.cpu.usage", 0.1, { node: "node-a", ns: "prod", pod: "api-1" }),
  fresh("k8s.pod.memory.working_set", 107_374_182, { node: "node-a", ns: "prod", pod: "api-1" }),
  fresh("k8s.pod.phase", 2, { ns: "prod", pod: "api-1" }),
  fresh("container.cpu.usage", 0.1, { node: "node-a", ns: "prod", pod: "api-1", container: "app" }),
  fresh("container.memory.working_set", 107_374_182, {
    node: "node-a",
    ns: "prod",
    pod: "api-1",
    container: "app",
  }),
  fresh("k8s.container.cpu_limit", 0.5, { ns: "prod", pod: "api-1", container: "app" }),
  fresh("k8s.container.memory_limit", 536_870_912, { ns: "prod", pod: "api-1", container: "app" }),
  fresh("k8s.container.restarts", 3, { ns: "prod", pod: "api-1", container: "app" }),
];

const WINDOW_ROWS = [
  windowRow(
    "container.memory.working_set",
    107_374_182,
    { ns: "prod", pod: "api-1", container: "app" },
    20,
  ),
  windowRow("container.cpu.usage", 0.1, { ns: "prod", pod: "api-1", container: "app" }, 20),
];

const respond =
  (freshRows: unknown[], windowRows: unknown[] = []) =>
  (sql: string): unknown[] =>
    isWindowCall(sql) ? windowRows : freshRows;

// ---- the statements ------------------------------------------------------

test("two scoped reads of metric_points_1m, both parameterised, neither naming a service (D457)", async () => {
  const { ch, calls } = recorder(respond(FRESH_ROWS, WINDOW_ROWS));
  await queryInfraSnapshot(ch);

  assert.equal(calls.length, 2, "D457 rules exactly two statements");
  for (const call of calls) {
    assert.ok(
      call.sql.includes("FROM obstack.metric_points_1m"),
      `infra read a table other than the 1m rollup: ${call.sql.trim().split("\n")[0]}`,
    );
    assert.equal(
      /obstack\.(?!metric_points_1m)/.test(call.sql),
      false,
      "the only obstack table this module may read is metric_points_1m",
    );
    assert.ok(call.sql.includes("{workspace_id:String}"), "a statement lost its tenancy predicate");
    assert.ok(!("workspace_id" in call.params), "the scope is the only thing allowed to bind it (D113)");
    assert.ok(!call.sql.includes("FINAL"), "the house rule is GROUP BY plus the matching combinator (D7)");
    // kubeletstats/k8s_cluster emit no `service.name`: every k8s series carries
    // `service = ''`, so a service predicate would return the empty set.
    assert.equal(
      /\bservice\b\s*(=|IN)/.test(call.sql),
      false,
      `a service predicate would exclude every k8s series: ${call.sql}`,
    );
    // D457's regex above names the two shapes a catalog read would use, and
    // misses the third: `service != ''` — the `trace_summaries_mv` rule this
    // module must NOT copy, and the one predicate that would empty the page
    // rather than narrow it (proven: adding it leaves the check above green).
    // Nothing in this module has any business naming the column at all.
    assert.equal(
      /\bservice\b/.test(call.sql),
      false,
      `the statement names the service column: ${call.sql}`,
    );
    assert.ok(call.sql.includes("GROUP BY name, series_hash"), "one row per series is the whole point");
  }
});

test("the 17 metric names are BOUND, never spliced into the statement (D11)", async () => {
  const { ch, calls } = recorder(respond([]));
  await queryInfraSnapshot(ch);

  const [freshCall, windowCall] = calls[0].sql.includes("first_bucket_s")
    ? [calls[1], calls[0]]
    : [calls[0], calls[1]];

  assert.deepEqual(freshCall.params.names, [...KUBELET_METRICS, ...CLUSTER_METRICS]);
  assert.equal(freshCall.params.stale_minutes, INFRA_STALE_MINUTES);
  assert.ok(freshCall.sql.includes("name IN {names:Array(String)}"));
  assert.ok(freshCall.sql.includes("now() - INTERVAL {stale_minutes:UInt32} MINUTE"));
  assert.ok(freshCall.sql.includes("argMaxMerge(gauge_last)"), "the latest value of a series is the argMax merge");
  assert.ok(freshCall.sql.includes("anyLast(attributes)"));

  assert.deepEqual(windowCall.params.names, ["container.memory.working_set", "container.cpu.usage"]);
  assert.equal(windowCall.params.window_hours, INFRA_RECS_WINDOW_HOURS);
  assert.ok(windowCall.sql.includes("now() - INTERVAL {window_hours:UInt32} HOUR"));
  assert.ok(windowCall.sql.includes("max(gauge_max)"));

  for (const name of [...KUBELET_METRICS, ...CLUSTER_METRICS]) {
    for (const call of calls) {
      assert.equal(
        call.sql.includes(`'${name}'`),
        false,
        `the statement spells "${name}" out as a literal instead of binding the whitelist`,
      );
    }
  }
});

// ---- what it makes of the rows -------------------------------------------

test("one node and one pod, every field decoded from its own series", async () => {
  const { ch } = recorder(respond(FRESH_ROWS, WINDOW_ROWS));
  const snap = await queryInfraSnapshot(ch);

  assert.deepEqual(snap.nodes, [
    {
      name: "node-a",
      ready: true,
      memoryPressure: false,
      cpuUsageCores: 1.2,
      cpuAllocatableCores: 4,
      memWorkingSetBytes: 6_442_450_944,
      memAvailableBytes: 10_737_418_240,
      memAllocatableBytes: 17_179_869_184,
      // the pod's own `k8s.node.name`, not a node-level series
      podCount: 1,
      lastSeen: NOW_ISO,
    },
  ]);
  assert.deepEqual(snap.pods, [
    {
      namespace: "prod",
      name: "api-1",
      node: "node-a",
      phase: "running",
      restarts: 3,
      cpuUsageCores: 0.1,
      cpuLimitCores: 0.5,
      memWorkingSetBytes: 107_374_182,
      memLimitBytes: 536_870_912,
      lastSeen: NOW_ISO,
    },
  ]);
  assert.equal(snap.totalNodes, 1);
  assert.equal(snap.totalPods, 1);
  assert.equal(snap.hasKubeletMetrics, true);
  assert.equal(snap.hasClusterMetrics, true);
  assert.equal(snap.asOf, NOW_ISO, "the newest fresh bucket across every series");
});

test("nothing fresh is nothing claimed: empty lists, both flags false, asOf null (D13)", async () => {
  const { ch } = recorder(respond([]));
  assert.deepEqual(await queryInfraSnapshot(ch), {
    nodes: [],
    totalNodes: 0,
    pods: [],
    totalPods: 0,
    recs: [],
    totalRecs: 0,
    hasKubeletMetrics: false,
    hasClusterMetrics: false,
    asOf: null,
  });
});

test("the phase decode table: 1..5 map in order, anything else is null", async () => {
  const cases: Array<[number, string | null]> = [
    [1, "pending"],
    [2, "running"],
    [3, "succeeded"],
    [4, "failed"],
    [5, "unknown"],
    [0, null],
    [6, null],
    [-1, null],
  ];
  for (const [value, expected] of cases) {
    const { ch } = recorder(respond([fresh("k8s.pod.phase", value, { ns: "prod", pod: "p" })]));
    const snap = await queryInfraSnapshot(ch);
    assert.equal(snap.pods[0].phase, expected, `k8s.pod.phase = ${value}`);
  }
});

test("the condition decode table: 1 true, 0 false, -1 unknown — and unknown is null, not false", async () => {
  const cases: Array<[number, boolean | null]> = [
    [1, true],
    [0, false],
    [-1, null],
  ];
  for (const [value, expected] of cases) {
    const { ch } = recorder(
      respond([
        fresh("k8s.node.condition_ready", value, { node: "n" }),
        fresh("k8s.node.condition_memory_pressure", value, { node: "n" }),
      ]),
    );
    const snap = await queryInfraSnapshot(ch);
    assert.equal(snap.nodes[0].ready, expected, `k8s.node.condition_ready = ${value}`);
    assert.equal(snap.nodes[0].memoryPressure, expected);
  }
  // A node with no condition series at all is the same answer as an unknown
  // one: null. `false` would render a red dot for a node nobody asked about.
  const { ch } = recorder(respond([fresh("k8s.node.cpu.usage", 1, { node: "n" })]));
  const snap = await queryInfraSnapshot(ch);
  assert.equal(snap.nodes[0].ready, null);
  assert.equal(snap.nodes[0].memoryPressure, null);
});

test("kubelet only: usage renders, every cluster-borne field is null and the flag says why", async () => {
  const kubeletOnly = FRESH_ROWS.filter((row) => (KUBELET_METRICS as readonly string[]).includes(row.name));
  const { ch } = recorder(respond(kubeletOnly, WINDOW_ROWS));
  const snap = await queryInfraSnapshot(ch);

  assert.equal(snap.hasKubeletMetrics, true);
  assert.equal(snap.hasClusterMetrics, false);
  assert.equal(snap.nodes[0].ready, null);
  assert.equal(snap.nodes[0].cpuAllocatableCores, null);
  assert.equal(snap.nodes[0].cpuUsageCores, 1.2);
  assert.equal(snap.pods[0].phase, null);
  assert.equal(snap.pods[0].restarts, null, "no cluster leg is null restarts, never 0");
  assert.equal(snap.pods[0].cpuLimitCores, null);
  assert.equal(snap.pods[0].memLimitBytes, null);
  assert.deepEqual(snap.recs, [], "no limit is nothing to size against");
});

test("cluster only: limits and phase render, usage is null and the flag says why", async () => {
  const clusterOnly = FRESH_ROWS.filter((row) => (CLUSTER_METRICS as readonly string[]).includes(row.name));
  const { ch } = recorder(respond(clusterOnly));
  const snap = await queryInfraSnapshot(ch);

  assert.equal(snap.hasKubeletMetrics, false);
  assert.equal(snap.hasClusterMetrics, true);
  assert.equal(snap.nodes[0].cpuUsageCores, null);
  assert.equal(snap.nodes[0].memWorkingSetBytes, null);
  assert.equal(snap.nodes[0].podCount, 0, "pod count is a kubelet reading");
  assert.equal(snap.pods[0].memWorkingSetBytes, null);
  assert.equal(snap.pods[0].phase, "running");
  assert.equal(snap.pods[0].restarts, 3);
  // No container reports usage, so the completeness rule is satisfied by every
  // limit that exists — the pod really is limited, we just cannot say how full.
  assert.equal(snap.pods[0].memLimitBytes, 536_870_912);
});

test("a pod-level limit is the sum of its containers' — and null when any container with usage lacks one (D457)", async () => {
  const base = [
    fresh("k8s.pod.memory.working_set", 1, { node: "n", ns: "prod", pod: "two" }),
    fresh("container.memory.working_set", 1, { ns: "prod", pod: "two", container: "app" }),
    fresh("container.cpu.usage", 1, { ns: "prod", pod: "two", container: "app" }),
    fresh("container.memory.working_set", 1, { ns: "prod", pod: "two", container: "sidecar" }),
    fresh("container.cpu.usage", 1, { ns: "prod", pod: "two", container: "sidecar" }),
    fresh("k8s.container.memory_limit", 100, { ns: "prod", pod: "two", container: "app" }),
    fresh("k8s.container.cpu_limit", 0.5, { ns: "prod", pod: "two", container: "app" }),
  ];

  const partial = recorder(respond(base));
  const partialSnap = await queryInfraSnapshot(partial.ch);
  assert.equal(
    partialSnap.pods[0].memLimitBytes,
    null,
    "the sidecar runs unlimited, so the pod has no limit — 100 would be smaller than the truth",
  );
  assert.equal(partialSnap.pods[0].cpuLimitCores, null);

  const complete = recorder(
    respond([
      ...base,
      fresh("k8s.container.memory_limit", 50, { ns: "prod", pod: "two", container: "sidecar" }),
      fresh("k8s.container.cpu_limit", 0.25, { ns: "prod", pod: "two", container: "sidecar" }),
    ]),
  );
  const completeSnap = await queryInfraSnapshot(complete.ch);
  assert.equal(completeSnap.pods[0].memLimitBytes, 150);
  assert.equal(completeSnap.pods[0].cpuLimitCores, 0.75);
});

test("nodes sort by name; pods by working set desc with the unmeasured ones last", async () => {
  const { ch } = recorder(
    respond([
      fresh("k8s.node.cpu.usage", 1, { node: "node-b" }),
      fresh("k8s.node.cpu.usage", 1, { node: "node-a" }),
      fresh("k8s.pod.memory.working_set", 10, { ns: "prod", pod: "small" }),
      fresh("k8s.pod.memory.working_set", 90, { ns: "prod", pod: "big" }),
      fresh("k8s.pod.phase", 2, { ns: "prod", pod: "unmeasured" }),
      fresh("k8s.pod.phase", 2, { ns: "a-ns", pod: "unmeasured" }),
    ]),
  );
  const snap = await queryInfraSnapshot(ch);
  assert.deepEqual(
    snap.nodes.map((n) => n.name),
    ["node-a", "node-b"],
  );
  assert.deepEqual(
    snap.pods.map((p) => `${p.namespace}/${p.name}`),
    ["prod/big", "prod/small", "a-ns/unmeasured", "prod/unmeasured"],
    "a pod with no working-set reading sorts after every pod that has one, then by namespace/name",
  );
});

// ---- the recs (D458) -----------------------------------------------------

/** One container, one limit, one window row — the smallest thing a rec can be made of. */
function recFixture(opts: {
  metric: "container.memory.working_set" | "container.cpu.usage";
  limitName: "k8s.container.memory_limit" | "k8s.container.cpu_limit";
  limit: number;
  peak: number;
  hours: number;
}) {
  const id = { ns: "prod", pod: "api-1", container: "app" };
  return respond(
    [fresh(opts.limitName, opts.limit, id), fresh(opts.metric, opts.peak, id)],
    [windowRow(opts.metric, opts.peak, id, opts.hours)],
  );
}

test("memory-limit-oversized: below 40% of the limit, and only after 12 observed hours", async () => {
  const oversized = recorder(
    recFixture({
      metric: "container.memory.working_set",
      limitName: "k8s.container.memory_limit",
      limit: 1000,
      peak: 399,
      hours: 20,
    }),
  );
  const snap = await queryInfraSnapshot(oversized.ch);
  assert.deepEqual(snap.recs, [
    {
      namespace: "prod",
      pod: "api-1",
      container: "app",
      kind: "memory-limit-oversized",
      peak: 399,
      limit: 1000,
      ratio: 0.399,
      observedHours: 20,
    },
  ]);
  assert.equal(snap.totalRecs, 1);
  assert.ok(0.399 < REC_MEMORY_OVERSIZED_BELOW, "the fixture sits under the ruled threshold");

  // Exactly at the threshold is not below it.
  const atThreshold = recorder(
    recFixture({
      metric: "container.memory.working_set",
      limitName: "k8s.container.memory_limit",
      limit: 1000,
      peak: 400,
      hours: 20,
    }),
  );
  assert.deepEqual((await queryInfraSnapshot(atThreshold.ch)).recs, []);

  // Same numbers, too little observation: D458 refuses to call a limit
  // oversized on a container it has watched for under 12 hours.
  const brief = recorder(
    recFixture({
      metric: "container.memory.working_set",
      limitName: "k8s.container.memory_limit",
      limit: 1000,
      peak: 399,
      hours: INFRA_RECS_MIN_OBSERVED_HOURS - 0.5,
    }),
  );
  assert.deepEqual((await queryInfraSnapshot(brief.ch)).recs, [], "11.5h of observation is not 12");

  const justEnough = recorder(
    recFixture({
      metric: "container.memory.working_set",
      limitName: "k8s.container.memory_limit",
      limit: 1000,
      peak: 399,
      hours: INFRA_RECS_MIN_OBSERVED_HOURS,
    }),
  );
  assert.equal((await queryInfraSnapshot(justEnough.ch)).recs.length, 1);
});

test("memory-near-limit and cpu-near-limit fire above their thresholds, with no observation floor", async () => {
  const nearMem = recorder(
    recFixture({
      metric: "container.memory.working_set",
      limitName: "k8s.container.memory_limit",
      limit: 1000,
      peak: 950,
      hours: 0,
    }),
  );
  const memSnap = await queryInfraSnapshot(nearMem.ch);
  assert.equal(memSnap.recs[0].kind, "memory-near-limit");
  assert.equal(memSnap.recs[0].ratio, 0.95);
  assert.equal(memSnap.recs[0].observedHours, 0, "a pod that just started can already be near its limit");
  assert.ok(0.95 > REC_MEMORY_NEAR_LIMIT_ABOVE);

  const atMem = recorder(
    recFixture({
      metric: "container.memory.working_set",
      limitName: "k8s.container.memory_limit",
      limit: 1000,
      peak: 900,
      hours: 20,
    }),
  );
  assert.deepEqual((await queryInfraSnapshot(atMem.ch)).recs, [], "exactly 90% is not above 90%");

  const nearCpu = recorder(
    recFixture({
      metric: "container.cpu.usage",
      limitName: "k8s.container.cpu_limit",
      limit: 1,
      peak: 0.9,
      hours: 1,
    }),
  );
  const cpuSnap = await queryInfraSnapshot(nearCpu.ch);
  assert.equal(cpuSnap.recs[0].kind, "cpu-near-limit");
  assert.equal(cpuSnap.recs[0].ratio, 0.9);
  assert.ok(0.9 > REC_CPU_NEAR_LIMIT_ABOVE);

  const atCpu = recorder(
    recFixture({
      metric: "container.cpu.usage",
      limitName: "k8s.container.cpu_limit",
      limit: 1,
      peak: 0.85,
      hours: 1,
    }),
  );
  assert.deepEqual((await queryInfraSnapshot(atCpu.ch)).recs, []);
  // An idle CPU is not an oversized limit: D458 rules no cpu oversized kind.
  const idleCpu = recorder(
    recFixture({
      metric: "container.cpu.usage",
      limitName: "k8s.container.cpu_limit",
      limit: 1,
      peak: 0.01,
      hours: 20,
    }),
  );
  assert.deepEqual((await queryInfraSnapshot(idleCpu.ch)).recs, []);
});

test("a limit of 0 is an unlimited container: no rec, and no division by it", async () => {
  for (const metric of ["container.memory.working_set", "container.cpu.usage"] as const) {
    const limitName =
      metric === "container.memory.working_set"
        ? "k8s.container.memory_limit"
        : "k8s.container.cpu_limit";
    const { ch } = recorder(recFixture({ metric, limitName, limit: 0, peak: 0, hours: 20 }));
    const snap = await queryInfraSnapshot(ch);
    assert.deepEqual(snap.recs, [], `${metric} against a limit of 0 produced a rec`);
    assert.equal(snap.totalRecs, 0);
  }
});

test("a window peak with no FRESH limit series produces nothing", async () => {
  const id = { ns: "prod", pod: "api-1", container: "app" };
  const { ch } = recorder(
    respond(
      [fresh("container.memory.working_set", 100, id)],
      [windowRow("container.memory.working_set", 100, id, 20)],
    ),
  );
  assert.deepEqual((await queryInfraSnapshot(ch)).recs, [], "no limit is nothing to size against");
});

test("recs order: near-limit first (worst ratio first), then oversized (most oversized first)", async () => {
  const container = (pod: string) => ({ ns: "prod", pod, container: "app" });
  const rows = [
    ["near-95", 950],
    ["near-99", 990],
    ["over-10", 100],
    ["over-30", 300],
  ] as const;
  const { ch } = recorder(
    respond(
      rows.flatMap(([pod, peak]) => [
        fresh("k8s.container.memory_limit", 1000, container(pod)),
        fresh("container.memory.working_set", peak, container(pod)),
      ]),
      rows.map(([pod, peak]) => windowRow("container.memory.working_set", peak, container(pod), 20)),
    ),
  );
  const snap = await queryInfraSnapshot(ch);
  assert.deepEqual(
    snap.recs.map((r) => `${r.pod}:${r.kind}`),
    [
      "near-99:memory-near-limit",
      "near-95:memory-near-limit",
      "over-10:memory-limit-oversized",
      "over-30:memory-limit-oversized",
    ],
  );
});

// ---- D402 caps and their totals ------------------------------------------

test("D402: nodes, pods and recs are capped and the totals say by how much", async () => {
  const container = (i: number) => ({
    ns: "prod",
    pod: `pod-${String(i).padStart(4, "0")}`,
    container: "app",
  });
  const extraNodes = INFRA_NODE_CAP + 1;
  const extraPods = INFRA_POD_CAP + 1;
  const extraRecs = INFRA_RECS_CAP + 1;

  const freshRows = [
    ...Array.from({ length: extraNodes }, (_, i) =>
      fresh("k8s.node.cpu.usage", 1, { node: `node-${String(i).padStart(4, "0")}` }),
    ),
    ...Array.from({ length: extraPods }, (_, i) => [
      fresh("k8s.pod.memory.working_set", extraPods - i, container(i)),
      ...(i < extraRecs
        ? [
            fresh("k8s.container.memory_limit", 1000, container(i)),
            fresh("container.memory.working_set", 950, container(i)),
          ]
        : []),
    ]).flat(),
  ];
  const windowRows = Array.from({ length: extraRecs }, (_, i) =>
    windowRow("container.memory.working_set", 950 + i, container(i), 20),
  );

  const { ch } = recorder(respond(freshRows, windowRows));
  const snap = await queryInfraSnapshot(ch);

  assert.equal(snap.nodes.length, INFRA_NODE_CAP);
  assert.equal(snap.totalNodes, extraNodes, "the total is the pre-cap count, not the page length");
  assert.equal(snap.pods.length, INFRA_POD_CAP);
  assert.equal(snap.totalPods, extraPods);
  assert.equal(snap.recs.length, INFRA_RECS_CAP);
  assert.equal(snap.totalRecs, extraRecs);
});
