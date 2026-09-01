import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { forWorkspace } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of D457: `infra.test.ts` proves what the module
// SENDS, and only a real server proves what the two statements COMPUTE — the
// `argMaxMerge` read of the AggregatingMergeTree, the 10-minute freshness
// bound, the 24h window's peaks and bucket bounds, the D375 merge that puts
// `k8s.*` RESOURCE attributes into the rollup's `attributes` map, and the
// tenancy that keeps two clusters with identical node and pod names apart.
//
// Seeding writes RAW rows into `metric_points` through the ingest user; the 1m
// MV fires synchronously on INSERT (metrics.integration.test.ts's measurement),
// so this proves the query layer without the collector.
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
 * (traces.integration.test.ts precedent): the seeding user has no mutation
 * grant, so nothing here can be cleaned up afterwards. `WORKSPACE_B` runs a
 * cluster with the SAME node, pod and container NAMES as A's, which is the only
 * fixture that can tell a scoped read from an unscoped one; the last two carry
 * one collector leg each, for the two D459 half-states.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;
const WORKSPACE_KUBELET = `ws_itk_${randomBytes(4).toString("hex")}`;
const WORKSPACE_CLUSTER = `ws_itc_${randomBytes(4).toString("hex")}`;

const NS_PER_SECOND = BigInt(1_000_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` — metrics.integration.test.ts's `chTimestamp`. */
function chTimestamp(epochS: number): string {
  const nanos = BigInt(epochS) * NS_PER_SECOND;
  const isoSeconds = new Date(epochS * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${(nanos % NS_PER_SECOND).toString().padStart(9, "0")}`;
}

/** What `formatDateTime(bucket, '%Y-%m-%dT%H:%iZ', 'UTC')` renders for the same instant. */
const isoMinute = (epochS: number): string => new Date(epochS * 1000).toISOString().slice(0, 16) + "Z";

/**
 * Every offset is anchored to a floored minute, so a point's `toStartOfMinute`
 * bucket is the point itself: a fixed "N seconds ago" would straddle a minute
 * boundary depending on when the clock reads `now`, and the assertions on
 * `lastSeen` and `observedHours` would flake with it.
 */
const BUCKET_S = Math.floor(Date.now() / 1000 / 60) * 60;
/** 2 minutes ago: inside `INFRA_STALE_MINUTES`. */
const FRESH_S = BUCKET_S - 120;
/** 3 minutes ago: the older point of a two-point series, so `argMaxMerge` has something to choose between. */
const EARLIER_S = BUCKET_S - 180;
/** 13 hours ago: inside the 24h recs window, far outside the freshness bound. */
const OLD_S = BUCKET_S - 13 * 3600;
/** 30 minutes ago: the whole point of the freshness bound. */
const STALE_S = BUCKET_S - 30 * 60;

interface Attrs {
  node?: string;
  ns?: string;
  pod?: string;
  container?: string;
}

/**
 * A raw gauge point. The k8s identity goes in `resource_attributes` — where
 * kubeletstats and k8s_cluster put it — and `attributes` stays empty, so this
 * fixture only reads back if the D375 `mapUpdate` merge really happened in the
 * MV. `service` is EMPTY on purpose: neither receiver emits `service.name`, and
 * a module that filtered on it would find nothing here.
 */
const seriesHashes = new Map<string, number>();
function point(workspace: string, name: string, value: number, attrs: Attrs, atS: number) {
  const resource_attributes: Record<string, string> = {
    ...(attrs.node === undefined ? {} : { "k8s.node.name": attrs.node }),
    ...(attrs.ns === undefined ? {} : { "k8s.namespace.name": attrs.ns }),
    ...(attrs.pod === undefined ? {} : { "k8s.pod.name": attrs.pod }),
    ...(attrs.container === undefined ? {} : { "k8s.container.name": attrs.container }),
  };
  const seriesKey = `${workspace}|${name}|${JSON.stringify(resource_attributes)}`;
  const series_hash = seriesHashes.get(seriesKey) ?? seriesHashes.size + 1;
  seriesHashes.set(seriesKey, series_hash);
  return {
    workspace_id: workspace,
    name,
    type: "gauge",
    unit: "1",
    service: "",
    series_hash,
    timestamp: chTimestamp(atS),
    value,
    is_monotonic: 0,
    bounds: [],
    bucket_counts: [],
    h_sum: 0,
    h_count: 0,
    h_min: 0,
    h_max: 0,
    attributes: {},
    resource_attributes,
  };
}

const A = (name: string, value: number, attrs: Attrs, atS = FRESH_S) =>
  point(WORKSPACE_ID, name, value, attrs, atS);

/**
 * Workspace A's cluster: two live nodes, four live pods and one of everything
 * that has to NOT show up. Every number below is chosen so the assertions are
 * pinned by construction — `api-1` peaks at exactly 20% of its 512MiB limit
 * over 13 observed hours (the ruled oversized shape), `worker-1` sits at 95% of
 * memory and 90% of CPU (both near-limit kinds), `unlimited-1` reports a limit
 * of 0, and `incomplete-1`'s sidecar has usage but no limit.
 */
const NODE_A_ROWS = [
  // Two points, three minutes apart: `argMaxMerge(gauge_last)` must return the
  // LATER value. A plain max/anyLast over the parts would return 9.9.
  A("k8s.node.cpu.usage", 9.9, { node: "node-a" }, EARLIER_S),
  A("k8s.node.cpu.usage", 1.2, { node: "node-a" }),
  A("k8s.node.memory.working_set", 6_442_450_944, { node: "node-a" }),
  A("k8s.node.memory.available", 10_737_418_240, { node: "node-a" }),
  A("k8s.node.allocatable_cpu", 4, { node: "node-a" }),
  A("k8s.node.allocatable_memory", 17_179_869_184, { node: "node-a" }),
  A("k8s.node.condition_ready", 1, { node: "node-a" }),
  A("k8s.node.condition_memory_pressure", 0, { node: "node-a" }),
];

const NODE_B_ROWS = [
  A("k8s.node.cpu.usage", 0.4, { node: "node-b" }),
  // 0 is `false`, and a node with no memory-pressure series at all is `null`:
  // the two live side by side here so neither can be mistaken for the other.
  A("k8s.node.condition_ready", 0, { node: "node-b" }),
];

const API_1 = { node: "node-a", ns: "prod", pod: "api-1" };
const API_1_APP = { ...API_1, container: "app" };
const API_1_ROWS = [
  A("k8s.pod.cpu.usage", 0.1, API_1),
  A("k8s.pod.memory.working_set", 107_374_182, API_1),
  A("k8s.pod.phase", 2, { ns: "prod", pod: "api-1" }),
  A("container.cpu.usage", 0.1, API_1_APP),
  A("container.memory.working_set", 107_374_182, API_1_APP),
  // The 13h-old point is what makes `observedHours` big enough for D458's
  // oversized call; drop it and the same peak yields no recommendation.
  A("container.memory.working_set", 107_374_182, API_1_APP, OLD_S),
  A("k8s.container.cpu_limit", 0.5, { ns: "prod", pod: "api-1", container: "app" }),
  A("k8s.container.memory_limit", 536_870_912, { ns: "prod", pod: "api-1", container: "app" }),
  A("k8s.container.restarts", 3, { ns: "prod", pod: "api-1", container: "app" }),
];

const WORKER_1 = { node: "node-b", ns: "prod", pod: "worker-1" };
const WORKER_1_C = { ...WORKER_1, container: "worker" };
const WORKER_1_ROWS = [
  A("k8s.pod.cpu.usage", 0.9, WORKER_1),
  A("k8s.pod.memory.working_set", 255_013_683, WORKER_1),
  A("k8s.pod.phase", 2, { ns: "prod", pod: "worker-1" }),
  A("container.cpu.usage", 0.9, WORKER_1_C),
  A("container.memory.working_set", 255_013_683, WORKER_1_C),
  A("k8s.container.cpu_limit", 1, { ns: "prod", pod: "worker-1", container: "worker" }),
  A("k8s.container.memory_limit", 268_435_456, { ns: "prod", pod: "worker-1", container: "worker" }),
  // Zero restarts is a MEASUREMENT; only a missing cluster leg is null.
  A("k8s.container.restarts", 0, { ns: "prod", pod: "worker-1", container: "worker" }),
];

const UNLIMITED_1 = { node: "node-b", ns: "prod", pod: "unlimited-1" };
const UNLIMITED_1_APP = { ...UNLIMITED_1, container: "app" };
const UNLIMITED_1_ROWS = [
  A("k8s.pod.memory.working_set", 50_000_000, UNLIMITED_1),
  A("container.memory.working_set", 50_000_000, UNLIMITED_1_APP),
  A("k8s.container.memory_limit", 0, { ns: "prod", pod: "unlimited-1", container: "app" }),
];

const INCOMPLETE_1 = { node: "node-a", ns: "prod", pod: "incomplete-1" };
const INCOMPLETE_1_ROWS = [
  A("k8s.pod.memory.working_set", 20_000_000, INCOMPLETE_1),
  A("container.memory.working_set", 10_000_000, { ...INCOMPLETE_1, container: "app" }),
  A("k8s.container.memory_limit", 1_000_000_000, {
    ns: "prod",
    pod: "incomplete-1",
    container: "app",
  }),
  // The sidecar reports usage and no limit: the pod's memory limit is therefore
  // unknown, not 1_000_000_000 (D457's completeness rule).
  A("container.memory.working_set", 10_000_000, { ...INCOMPLETE_1, container: "sidecar" }),
];

/**
 * Everything below is 30 minutes old. A series with no bucket in the last
 * `INFRA_STALE_MINUTES` is ABSENT, not "still running at its last value" — this
 * node and this pod must not appear at all, and the stale container's limit
 * must not produce a recommendation even though its window peak is inside 24h.
 */
const STALE_ROWS = [
  A("k8s.node.cpu.usage", 5, { node: "node-stale" }, STALE_S),
  A("k8s.node.condition_ready", 1, { node: "node-stale" }, STALE_S),
  A("k8s.pod.memory.working_set", 999, { node: "node-a", ns: "prod", pod: "stale-1" }, STALE_S),
  A(
    "container.memory.working_set",
    999,
    { node: "node-a", ns: "prod", pod: "stale-1", container: "app" },
    STALE_S,
  ),
  A("k8s.container.memory_limit", 1000, { ns: "prod", pod: "stale-1", container: "app" }, STALE_S),
];

/** The same node, pod and container NAMES in a second tenant, with different numbers. */
const TENANT_B_ROWS = [
  point(WORKSPACE_B, "k8s.node.cpu.usage", 7.7, { node: "node-a" }, FRESH_S),
  point(WORKSPACE_B, "k8s.node.condition_ready", 1, { node: "node-a" }, FRESH_S),
  point(WORKSPACE_B, "k8s.pod.memory.working_set", 42, { node: "node-a", ns: "prod", pod: "api-1" }, FRESH_S),
  point(
    WORKSPACE_B,
    "container.memory.working_set",
    42,
    { node: "node-a", ns: "prod", pod: "api-1", container: "app" },
    FRESH_S,
  ),
  point(
    WORKSPACE_B,
    "k8s.container.memory_limit",
    99,
    { ns: "prod", pod: "api-1", container: "app" },
    FRESH_S,
  ),
];

/** The DaemonSet reporting alone: usage everywhere, nothing the cluster API knows. */
const KUBELET_ONLY_ROWS = [
  point(WORKSPACE_KUBELET, "k8s.node.cpu.usage", 2, { node: "node-k" }, FRESH_S),
  point(WORKSPACE_KUBELET, "k8s.node.memory.working_set", 1000, { node: "node-k" }, FRESH_S),
  point(
    WORKSPACE_KUBELET,
    "k8s.pod.memory.working_set",
    500,
    { node: "node-k", ns: "prod", pod: "kube-1" },
    FRESH_S,
  ),
  point(
    WORKSPACE_KUBELET,
    "container.cpu.usage",
    0.2,
    { node: "node-k", ns: "prod", pod: "kube-1", container: "app" },
    FRESH_S,
  ),
  point(
    WORKSPACE_KUBELET,
    "container.memory.working_set",
    500,
    { node: "node-k", ns: "prod", pod: "kube-1", container: "app" },
    FRESH_S,
  ),
];

/** The cluster singleton reporting alone: readiness, phase, restarts and limits — no usage at all. */
const CLUSTER_ONLY_ROWS = [
  point(WORKSPACE_CLUSTER, "k8s.node.condition_ready", 1, { node: "node-c" }, FRESH_S),
  point(WORKSPACE_CLUSTER, "k8s.node.condition_memory_pressure", 1, { node: "node-c" }, FRESH_S),
  point(WORKSPACE_CLUSTER, "k8s.node.allocatable_cpu", 2, { node: "node-c" }, FRESH_S),
  point(WORKSPACE_CLUSTER, "k8s.node.allocatable_memory", 1000, { node: "node-c" }, FRESH_S),
  point(WORKSPACE_CLUSTER, "k8s.pod.phase", 4, { ns: "prod", pod: "clus-1" }, FRESH_S),
  point(
    WORKSPACE_CLUSTER,
    "k8s.container.restarts",
    7,
    { ns: "prod", pod: "clus-1", container: "app" },
    FRESH_S,
  ),
  point(
    WORKSPACE_CLUSTER,
    "k8s.container.memory_limit",
    100,
    { ns: "prod", pod: "clus-1", container: "app" },
    FRESH_S,
  ),
  point(
    WORKSPACE_CLUSTER,
    "k8s.container.cpu_limit",
    1,
    { ns: "prod", pod: "clus-1", container: "app" },
    FRESH_S,
  ),
];

test("the k8s cluster view (D457) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    const why = `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`;
    assert.ok(!process.env.CI, why);
    t.skip(`${why} — skipped locally, fails on CI`);
    return;
  }

  const { queryInfraSnapshot } = await import("./infra");

  await seed.insert({
    table: "metric_points",
    format: "JSONEachRow",
    values: [
      ...NODE_A_ROWS,
      ...NODE_B_ROWS,
      ...API_1_ROWS,
      ...WORKER_1_ROWS,
      ...UNLIMITED_1_ROWS,
      ...INCOMPLETE_1_ROWS,
      ...STALE_ROWS,
      ...TENANT_B_ROWS,
      ...KUBELET_ONLY_ROWS,
      ...CLUSTER_ONLY_ROWS,
    ],
  });

  const ch = forWorkspace(WORKSPACE_ID);

  await t.test("nodes: the merged resource attributes name them, argMaxMerge dates them", async () => {
    const snap = await queryInfraSnapshot(ch);
    assert.deepEqual(
      snap.nodes.map((n) => n.name),
      ["node-a", "node-b"],
      "`node-stale` reported 30 minutes ago and is therefore absent, not idle",
    );
    assert.equal(snap.totalNodes, 2);
    assert.deepEqual(snap.nodes[0], {
      name: "node-a",
      ready: true,
      memoryPressure: false,
      // 1.2, not the 9.9 the earlier point carried: this is the merge read.
      cpuUsageCores: 1.2,
      cpuAllocatableCores: 4,
      memWorkingSetBytes: 6_442_450_944,
      memAvailableBytes: 10_737_418_240,
      memAllocatableBytes: 17_179_869_184,
      podCount: 2,
      lastSeen: isoMinute(FRESH_S),
    });
    assert.equal(snap.nodes[1].ready, false, "condition 0 is false");
    assert.equal(snap.nodes[1].memoryPressure, null, "no series is null, never false");
    assert.equal(snap.nodes[1].cpuAllocatableCores, null);
    assert.equal(snap.nodes[1].podCount, 2);
    assert.equal(snap.asOf, isoMinute(FRESH_S));
    assert.equal(snap.hasKubeletMetrics, true);
    assert.equal(snap.hasClusterMetrics, true);
  });

  await t.test("pods: ranked by working set, limits summed only when nothing is missing", async () => {
    const snap = await queryInfraSnapshot(ch);
    assert.deepEqual(
      snap.pods.map((p) => p.name),
      ["worker-1", "api-1", "unlimited-1", "incomplete-1"],
      "`stale-1`'s last bucket is 30 minutes old",
    );
    assert.equal(snap.totalPods, 4);

    const byName = new Map(snap.pods.map((p) => [p.name, p]));
    assert.deepEqual(byName.get("api-1"), {
      namespace: "prod",
      name: "api-1",
      node: "node-a",
      phase: "running",
      restarts: 3,
      cpuUsageCores: 0.1,
      cpuLimitCores: 0.5,
      memWorkingSetBytes: 107_374_182,
      memLimitBytes: 536_870_912,
      lastSeen: isoMinute(FRESH_S),
    });
    assert.equal(byName.get("worker-1")?.node, "node-b");
    assert.equal(byName.get("worker-1")?.restarts, 0, "zero restarts is a reading, not a gap");
    assert.equal(
      byName.get("incomplete-1")?.memLimitBytes,
      null,
      "the sidecar has usage and no limit, so the pod's limit is unknown (D457)",
    );
    assert.equal(byName.get("incomplete-1")?.restarts, null, "this pod has no restarts series at all");
    assert.equal(byName.get("unlimited-1")?.cpuLimitCores, null, "no cpu limit series at all");
  });

  await t.test("recs: near-limit first, then oversized — and the 24h window dates them", async () => {
    const snap = await queryInfraSnapshot(ch);
    assert.deepEqual(
      snap.recs.map((r) => `${r.pod}/${r.container}:${r.kind}`),
      [
        "worker-1/worker:memory-near-limit",
        "worker-1/worker:cpu-near-limit",
        "api-1/app:memory-limit-oversized",
      ],
    );
    assert.equal(snap.totalRecs, 3);

    const oversized = snap.recs[2];
    assert.equal(oversized.peak, 107_374_182);
    assert.equal(oversized.limit, 536_870_912);
    assert.ok(Math.abs(oversized.ratio - 0.2) < 1e-9, `ratio was ${oversized.ratio}`);
    assert.equal(
      oversized.observedHours,
      (FRESH_S - OLD_S) / 3600,
      "the window's own min and max bucket, not the window's width",
    );

    const pods = snap.recs.map((r) => r.pod);
    assert.equal(pods.includes("unlimited-1"), false, "a limit of 0 is not a limit to size against");
    assert.equal(pods.includes("stale-1"), false, "its window peak is inside 24h, but its limit is not fresh");
    assert.equal(
      pods.includes("incomplete-1"),
      false,
      "10MB against a 1GB limit over one bucket: under 40%, but nowhere near 12 observed hours",
    );
  });

  await t.test("a second workspace sees none of it — under the SAME node, pod and container names", async () => {
    const snap = await queryInfraSnapshot(forWorkspace(WORKSPACE_B));
    assert.deepEqual(
      snap.nodes.map((n) => n.name),
      ["node-a"],
      "`node-b` is the other tenant's, under a name this one also uses",
    );
    assert.equal(snap.nodes[0].cpuUsageCores, 7.7, "tenant B's own reading, never tenant A's 1.2");
    assert.equal(snap.nodes[0].podCount, 1);
    assert.equal(snap.totalNodes, 1);
    assert.deepEqual(
      snap.pods.map((p) => p.name),
      ["api-1"],
    );
    assert.equal(snap.pods[0].memWorkingSetBytes, 42);
    assert.equal(snap.pods[0].memLimitBytes, 99);
    assert.equal(snap.pods[0].restarts, null);
    assert.equal(snap.pods[0].phase, null);
    assert.equal(snap.totalPods, 1);
    assert.deepEqual(snap.recs, [], "42 of 99 bytes is neither near a limit nor oversized");
  });

  await t.test("the kubelet leg alone: usage, and every cluster-borne field null", async () => {
    const snap = await queryInfraSnapshot(forWorkspace(WORKSPACE_KUBELET));
    assert.equal(snap.hasKubeletMetrics, true);
    assert.equal(snap.hasClusterMetrics, false);
    assert.equal(snap.nodes[0].cpuUsageCores, 2);
    assert.equal(snap.nodes[0].ready, null);
    assert.equal(snap.nodes[0].cpuAllocatableCores, null);
    assert.equal(snap.nodes[0].memAllocatableBytes, null);
    assert.equal(snap.nodes[0].podCount, 1);
    assert.equal(snap.pods[0].name, "kube-1");
    assert.equal(snap.pods[0].memWorkingSetBytes, 500);
    assert.equal(snap.pods[0].phase, null);
    assert.equal(snap.pods[0].restarts, null);
    assert.equal(snap.pods[0].cpuLimitCores, null);
    assert.equal(snap.pods[0].memLimitBytes, null);
    assert.deepEqual(snap.recs, [], "right-sizing needs limits, and the cluster leg has them");
  });

  await t.test("the cluster leg alone: phase, restarts and limits, and every usage field null", async () => {
    const snap = await queryInfraSnapshot(forWorkspace(WORKSPACE_CLUSTER));
    assert.equal(snap.hasKubeletMetrics, false);
    assert.equal(snap.hasClusterMetrics, true);
    assert.equal(snap.nodes[0].ready, true);
    assert.equal(snap.nodes[0].memoryPressure, true);
    assert.equal(snap.nodes[0].cpuAllocatableCores, 2);
    assert.equal(snap.nodes[0].cpuUsageCores, null);
    assert.equal(snap.nodes[0].memWorkingSetBytes, null);
    assert.equal(snap.nodes[0].podCount, 0, "the pod count is a kubelet reading");
    assert.equal(snap.pods[0].name, "clus-1");
    assert.equal(snap.pods[0].phase, "failed");
    assert.equal(snap.pods[0].restarts, 7);
    assert.equal(snap.pods[0].cpuUsageCores, null);
    assert.equal(snap.pods[0].memWorkingSetBytes, null);
    // No container reports usage, so nothing is missing from the sum: the pod
    // really is limited, we just cannot yet say how full it is.
    assert.equal(snap.pods[0].memLimitBytes, 100);
    assert.equal(snap.pods[0].cpuLimitCores, 1);
    assert.deepEqual(snap.recs, [], "no usage is nothing to compare against a limit");
  });

  await t.test("a workspace that never sent a k8s metric says so, rather than showing an empty cluster", async () => {
    const snap = await queryInfraSnapshot(forWorkspace(`ws_itn_${randomBytes(4).toString("hex")}`));
    assert.equal(snap.hasKubeletMetrics, false);
    assert.equal(snap.hasClusterMetrics, false);
    assert.equal(snap.asOf, null);
    assert.deepEqual(snap.nodes, []);
    assert.deepEqual(snap.pods, []);
    assert.deepEqual(snap.recs, []);
  });
});
