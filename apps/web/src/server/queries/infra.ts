import "server-only";
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
  type InfraNode,
  type InfraPod,
  type InfraSnapshot,
  type PodPhase,
  type RecKind,
  type RightsizingRec,
} from "@/lib/infra-types";
import type { ScopedClickHouse } from "@/server/clickhouse";

/**
 * The cluster view (D457), read from the S6.1 metric store and nothing else:
 * the collector's `kubelet_stats` and `k8s_cluster` legs (D450) land in
 * `metric_points_1m` like every other metric, and the k8s identity lives in the
 * rollup's MERGED `attributes` map (D375) rather than in columns of its own.
 *
 * Two statements, both `GROUP BY` the series key with the matching combinators
 * (never FINAL, never a bare SELECT — the D7 house rule the 0005 DDL restates):
 * one for the FRESH state of every k8s series, one for the 24h peaks the
 * right-sizing recommendations are made of. Everything after that — which
 * series belongs to which node, pod and container, the caps, the totals and the
 * recs — is TypeScript over at most a few thousand rows (the ingest series cap
 * is 25k per workspace per day, and this reads a 17-name slice of it).
 *
 * There is NO `service` predicate anywhere below, deliberately: kubeletstats
 * and k8s_cluster emit no `service.name`, so every series here has
 * `service = ''` and a catalog-style `service != ''` filter would return the
 * empty set. `infra.test.ts` holds that as a tripwire.
 *
 * Every `null` this module returns means "no fresh series for this key" (D13),
 * never 0: a node whose cluster leg is off has `ready: null`, not `false`.
 */

/** The whole whitelist (D450), bound as one parameter — never spelled into the SQL (D11). */
const FRESH_NAMES = [...KUBELET_METRICS, ...CLUSTER_METRICS];

/** The two container gauges the recs read over 24h; the type pins both to the whitelist (condition 13). */
const WINDOW_NAMES: (typeof KUBELET_METRICS)[number][] = [
  "container.memory.working_set",
  "container.cpu.usage",
];

/** The statement binds exactly the two lists, so "not kubelet" is "cluster". */
const KUBELET_NAMES = new Set<string>(KUBELET_METRICS);

/**
 * One row per fresh series. `gauge_last` is an `AggregateFunction(argMax, …)`,
 * so the latest value of a series is `argMaxMerge` over its parts — the same
 * merge `metrics.ts` finalizes with, applied at the series key directly because
 * this read never regroups across series.
 */
const FRESH_SERIES_SQL = `
SELECT
    name,
    argMaxMerge(gauge_last)                               AS value,
    anyLast(attributes)                                   AS attributes,
    formatDateTime(max(bucket), '%Y-%m-%dT%H:%iZ', 'UTC') AS last_seen_iso
FROM obstack.metric_points_1m
WHERE workspace_id = {workspace_id:String}
  AND name IN {names:Array(String)}
  AND bucket >= now() - INTERVAL {stale_minutes:UInt32} MINUTE
GROUP BY name, series_hash`;

/**
 * One row per container series over the recs window. `gauge_max` is a
 * `SimpleAggregateFunction(max, …)`, associative, so re-applying `max` across
 * the window's buckets is the window peak; the two bucket bounds are what
 * `observedHours` is measured from — a container seen once is not a container
 * observed for a day, and D458's oversized call refuses to be made on it.
 */
const CONTAINER_WINDOW_SQL = `
SELECT
    name,
    anyLast(attributes)                    AS attributes,
    max(gauge_max)                         AS peak,
    toUInt32(toUnixTimestamp(min(bucket))) AS first_bucket_s,
    toUInt32(toUnixTimestamp(max(bucket))) AS last_bucket_s
FROM obstack.metric_points_1m
WHERE workspace_id = {workspace_id:String}
  AND name IN {names:Array(String)}
  AND bucket >= now() - INTERVAL {window_hours:UInt32} HOUR
GROUP BY name, series_hash`;

interface FreshRow {
  name: string;
  value: number;
  attributes: Record<string, string>;
  last_seen_iso: string;
}

interface WindowRow {
  name: string;
  attributes: Record<string, string>;
  peak: number;
  first_bucket_s: number;
  last_bucket_s: number;
}

// ---- identity (D453 scrubs uid and container.id, so these keys are it) -----

const NODE_ATTR = "k8s.node.name";
const NAMESPACE_ATTR = "k8s.namespace.name";
const POD_ATTR = "k8s.pod.name";
const CONTAINER_ATTR = "k8s.container.name";

/** A space cannot occur in a k8s name, so a composite key can never collide. */
const key = (...parts: string[]): string => parts.join(" ");

const NODE_GAUGES = {
  "k8s.node.cpu.usage": "cpuUsageCores",
  "k8s.node.memory.working_set": "memWorkingSetBytes",
  "k8s.node.memory.available": "memAvailableBytes",
  "k8s.node.allocatable_cpu": "cpuAllocatableCores",
  "k8s.node.allocatable_memory": "memAllocatableBytes",
} as const satisfies Record<string, keyof InfraNode>;

const NODE_CONDITIONS = {
  "k8s.node.condition_ready": "ready",
  "k8s.node.condition_memory_pressure": "memoryPressure",
} as const satisfies Record<string, keyof InfraNode>;

const POD_GAUGES = {
  "k8s.pod.cpu.usage": "cpuUsageCores",
  "k8s.pod.memory.working_set": "memWorkingSetBytes",
} as const satisfies Record<string, keyof InfraPod>;

/** k8s_cluster reports 1 true / 0 false / -1 unknown; unknown is not false (D13). */
const decodeCondition = (value: number): boolean | null =>
  value === 1 ? true : value === 0 ? false : null;

/** `k8s.pod.phase` 1..5, the k8sclusterreceiver's own encoding. */
const PHASES: readonly PodPhase[] = ["pending", "running", "succeeded", "failed", "unknown"];
const decodePhase = (value: number): PodPhase | null => PHASES[value - 1] ?? null;

/** Both ISO strings are the same fixed-width UTC format, so the later one sorts later. */
const later = (a: string, b: string): string => (b > a ? b : a);

interface ContainerDraft {
  hasCpuUsage: boolean;
  hasMemUsage: boolean;
  cpuLimit: number | null;
  memLimit: number | null;
  restarts: number | null;
}

interface PodDraft extends Omit<InfraPod, "restarts" | "cpuLimitCores" | "memLimitBytes"> {
  containers: Map<string, ContainerDraft>;
}

function newNode(name: string, lastSeen: string): InfraNode {
  return {
    name,
    ready: null,
    memoryPressure: null,
    cpuUsageCores: null,
    cpuAllocatableCores: null,
    memWorkingSetBytes: null,
    memAvailableBytes: null,
    memAllocatableBytes: null,
    podCount: 0,
    lastSeen,
  };
}

function newPod(namespace: string, name: string, lastSeen: string): PodDraft {
  return {
    namespace,
    name,
    node: null,
    phase: null,
    cpuUsageCores: null,
    memWorkingSetBytes: null,
    containers: new Map(),
    lastSeen,
  };
}

function newContainer(): ContainerDraft {
  return { hasCpuUsage: false, hasMemUsage: false, cpuLimit: null, memLimit: null, restarts: null };
}

/**
 * The pod's limit is the SUM of its containers' limits, and a sum is only a
 * limit if nothing is missing from it (D457): a pod whose sidecar runs
 * unlimited has no limit, and rendering the app container's 512Mi as the pod's
 * would be a smaller number than the truth. Containers with no fresh usage do
 * not participate — they are not part of what the usage column measures.
 *
 * No limit series at all (the kubelet-only cluster) is `null` by the same rule
 * the rest of this module follows, not the 0 an empty sum would produce.
 */
function podLimit(
  containers: Iterable<ContainerDraft>,
  limitOf: (c: ContainerDraft) => number | null,
  usedBy: (c: ContainerDraft) => boolean,
): number | null {
  let sum: number | null = null;
  for (const container of containers) {
    const limit = limitOf(container);
    if (limit === null) {
      if (usedBy(container)) return null;
      continue;
    }
    sum = (sum ?? 0) + limit;
  }
  return sum;
}

/** Sum over the containers that reported restarts; no cluster leg for this pod is `null`, not 0. */
function podRestarts(containers: Iterable<ContainerDraft>): number | null {
  let sum: number | null = null;
  for (const container of containers) {
    if (container.restarts !== null) sum = (sum ?? 0) + container.restarts;
  }
  return sum;
}

/** D457: memory desc, and a pod with no working-set reading sorts after every pod that has one. */
function comparePods(a: InfraPod, b: InfraPod): number {
  const am = a.memWorkingSetBytes;
  const bm = b.memWorkingSetBytes;
  if (am !== bm) {
    if (am === null) return 1;
    if (bm === null) return -1;
    return bm - am;
  }
  return a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);
}

/** D457's kind order: "near its limit" before "oversized". */
const NEAR_LIMIT: readonly RecKind[] = ["memory-near-limit", "cpu-near-limit"];

/**
 * Near-limit first, worst ratio first; then the oversized ones, most oversized
 * first. The identity tie-break keeps two containers at the same ratio from
 * swapping places between renders.
 */
function compareRecs(a: RightsizingRec, b: RightsizingRec): number {
  const aNear = NEAR_LIMIT.includes(a.kind);
  const bNear = NEAR_LIMIT.includes(b.kind);
  if (aNear !== bNear) return aNear ? -1 : 1;
  if (a.ratio !== b.ratio) return aNear ? b.ratio - a.ratio : a.ratio - b.ratio;
  return (
    a.namespace.localeCompare(b.namespace) ||
    a.pod.localeCompare(b.pod) ||
    a.container.localeCompare(b.container) ||
    a.kind.localeCompare(b.kind)
  );
}

/**
 * The whole cluster view in two reads. Nodes, pods and containers are assembled
 * from the fresh set; the recs join that set's LATEST limits against the
 * window's peaks, so a limit that stopped being reported takes its
 * recommendations with it rather than leaving a stale one on the page.
 */
export async function queryInfraSnapshot(ch: ScopedClickHouse): Promise<InfraSnapshot> {
  const [fresh, windowRows] = await Promise.all([
    ch.queryRows<FreshRow>(FRESH_SERIES_SQL, {
      names: FRESH_NAMES,
      stale_minutes: INFRA_STALE_MINUTES,
    }),
    ch.queryRows<WindowRow>(CONTAINER_WINDOW_SQL, {
      names: WINDOW_NAMES,
      window_hours: INFRA_RECS_WINDOW_HOURS,
    }),
  ]);

  const nodes = new Map<string, InfraNode>();
  const pods = new Map<string, PodDraft>();
  /** Counted apart from the node rows: a pod's series may arrive before its node's. */
  const podsByNode = new Map<string, Set<string>>();
  let asOf: string | null = null;
  let hasKubeletMetrics = false;
  let hasClusterMetrics = false;

  for (const row of fresh) {
    asOf = asOf === null ? row.last_seen_iso : later(asOf, row.last_seen_iso);
    if (KUBELET_NAMES.has(row.name)) hasKubeletMetrics = true;
    else hasClusterMetrics = true;

    const attrs = row.attributes ?? {};
    const nodeName = attrs[NODE_ATTR] ?? "";
    const podName = attrs[POD_ATTR] ?? "";
    const namespace = attrs[NAMESPACE_ATTR] ?? "";
    const containerName = attrs[CONTAINER_ATTR] ?? "";

    // A node row is made of node-level series only. The `k8s.node.name` the
    // DaemonSet stamps onto pod and container series (D453) names the node a
    // pod runs ON; it must not conjure a node out of a pod's attributes.
    if (nodeName !== "" && podName === "") {
      const node = nodes.get(nodeName) ?? newNode(nodeName, row.last_seen_iso);
      node.lastSeen = later(node.lastSeen, row.last_seen_iso);
      if (row.name in NODE_GAUGES) {
        node[NODE_GAUGES[row.name as keyof typeof NODE_GAUGES]] = row.value;
      } else if (row.name in NODE_CONDITIONS) {
        node[NODE_CONDITIONS[row.name as keyof typeof NODE_CONDITIONS]] = decodeCondition(row.value);
      }
      nodes.set(nodeName, node);
    }

    if (podName === "") continue;

    const podKey = key(namespace, podName);
    const pod = pods.get(podKey) ?? newPod(namespace, podName, row.last_seen_iso);
    pod.lastSeen = later(pod.lastSeen, row.last_seen_iso);
    if (nodeName !== "") pod.node = nodeName;
    pods.set(podKey, pod);

    if (row.name in POD_GAUGES) {
      pod[POD_GAUGES[row.name as keyof typeof POD_GAUGES]] = row.value;
    } else if (row.name === "k8s.pod.phase") {
      pod.phase = decodePhase(row.value);
    }
    // D457: a node's pod count is its fresh pod working-set series — the one
    // pod-level reading every reporting pod has.
    if (row.name === "k8s.pod.memory.working_set" && nodeName !== "") {
      const onNode = podsByNode.get(nodeName) ?? new Set<string>();
      onNode.add(podKey);
      podsByNode.set(nodeName, onNode);
    }

    if (containerName === "") continue;
    const container = pod.containers.get(containerName) ?? newContainer();
    pod.containers.set(containerName, container);
    switch (row.name) {
      case "container.cpu.usage":
        container.hasCpuUsage = true;
        break;
      case "container.memory.working_set":
        container.hasMemUsage = true;
        break;
      case "k8s.container.cpu_limit":
        container.cpuLimit = row.value;
        break;
      case "k8s.container.memory_limit":
        container.memLimit = row.value;
        break;
      case "k8s.container.restarts":
        container.restarts = row.value;
        break;
    }
  }

  const containersByKey = new Map<string, ContainerDraft>();
  for (const pod of pods.values()) {
    for (const [name, container] of pod.containers) {
      containersByKey.set(key(pod.namespace, pod.name, name), container);
    }
  }

  const recs = buildRecs(windowRows, containersByKey);

  const nodeRows = [...nodes.values()]
    .map((node) => ({ ...node, podCount: podsByNode.get(node.name)?.size ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const podRows: InfraPod[] = [...pods.values()]
    .map(({ containers, ...pod }) => ({
      ...pod,
      restarts: podRestarts(containers.values()),
      cpuLimitCores: podLimit(
        containers.values(),
        (c) => c.cpuLimit,
        (c) => c.hasCpuUsage,
      ),
      memLimitBytes: podLimit(
        containers.values(),
        (c) => c.memLimit,
        (c) => c.hasMemUsage,
      ),
    }))
    .sort(comparePods);

  return {
    nodes: nodeRows.slice(0, INFRA_NODE_CAP),
    totalNodes: nodeRows.length,
    pods: podRows.slice(0, INFRA_POD_CAP),
    totalPods: podRows.length,
    recs: recs.slice(0, INFRA_RECS_CAP),
    totalRecs: recs.length,
    hasKubeletMetrics,
    hasClusterMetrics,
    asOf,
  };
}

/**
 * D458, per container: the window's peak against the container's LATEST limit,
 * and only where that limit has a fresh series — a recommendation about a limit
 * nobody reports any more is a recommendation about the past.
 *
 * A limit of 0 is not a limit (it is how an unlimited container reports), so it
 * yields no rec and no division. "Oversized" additionally waits for
 * `INFRA_RECS_MIN_OBSERVED_HOURS` of observation inside the window: a container
 * seen for ten minutes has not yet had its busy hour.
 */
function buildRecs(rows: WindowRow[], containers: Map<string, ContainerDraft>): RightsizingRec[] {
  const recs: RightsizingRec[] = [];
  for (const row of rows) {
    const attrs = row.attributes ?? {};
    const namespace = attrs[NAMESPACE_ATTR] ?? "";
    const pod = attrs[POD_ATTR] ?? "";
    const container = attrs[CONTAINER_ATTR] ?? "";
    if (pod === "" || container === "") continue;
    const draft = containers.get(key(namespace, pod, container));
    if (!draft) continue;

    const memory = row.name === "container.memory.working_set";
    const limit = memory ? draft.memLimit : draft.cpuLimit;
    if (limit === null || limit <= 0) continue;

    const ratio = row.peak / limit;
    const observedHours = (row.last_bucket_s - row.first_bucket_s) / 3600;
    const kind: RecKind | null = memory
      ? ratio > REC_MEMORY_NEAR_LIMIT_ABOVE
        ? "memory-near-limit"
        : ratio < REC_MEMORY_OVERSIZED_BELOW && observedHours >= INFRA_RECS_MIN_OBSERVED_HOURS
          ? "memory-limit-oversized"
          : null
      : ratio > REC_CPU_NEAR_LIMIT_ABOVE
        ? "cpu-near-limit"
        : null;
    if (kind === null) continue;

    recs.push({ namespace, pod, container, kind, peak: row.peak, limit, ratio, observedHours });
  }
  return recs.sort(compareRecs);
}
