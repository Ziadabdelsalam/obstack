/**
 * S6.4 infra contract (D456). Client-safe: imports nothing. Read by
 * server/queries/infra.ts, components/infra/InfraLive.tsx and the kind
 * acceptance (deploy/helm/obstack/acceptance.ts). Every `null` means "no
 * fresh series for this key" (D13) — never 0.
 */

/** A series with no bucket in the last N minutes is ABSENT, not "running". */
export const INFRA_STALE_MINUTES = 10;
/** Right-sizing window (D458). */
export const INFRA_RECS_WINDOW_HOURS = 24;
/** "oversized" needs at least this much observation inside the window (D458). */
export const INFRA_RECS_MIN_OBSERVED_HOURS = 12;
/** D402 caps; totals are pre-truncation. */
export const INFRA_NODE_CAP = 100;
export const INFRA_POD_CAP = 500;
export const INFRA_RECS_CAP = 50;
/** D458 thresholds, as ratios of the container's latest limit. */
export const REC_MEMORY_OVERSIZED_BELOW = 0.4;
export const REC_MEMORY_NEAR_LIMIT_ABOVE = 0.9;
export const REC_CPU_NEAR_LIMIT_ABOVE = 0.85;

/** kubelet_stats names (the DaemonSet leg, D450); any fresh one ⇒ hasKubeletMetrics. */
export const KUBELET_METRICS = [
  "k8s.node.cpu.usage",
  "k8s.node.memory.working_set",
  "k8s.node.memory.available",
  "k8s.pod.cpu.usage",
  "k8s.pod.memory.working_set",
  "container.cpu.usage",
  "container.memory.working_set",
] as const;
/** k8s_cluster names (the cluster collector leg, D450); any fresh one ⇒ hasClusterMetrics. */
export const CLUSTER_METRICS = [
  "k8s.node.condition_ready",
  "k8s.node.condition_memory_pressure",
  "k8s.node.allocatable_cpu",
  "k8s.node.allocatable_memory",
  "k8s.pod.phase",
  "k8s.container.restarts",
  "k8s.container.cpu_request",
  "k8s.container.cpu_limit",
  "k8s.container.memory_request",
  "k8s.container.memory_limit",
] as const;

export interface InfraNode {
  name: string;
  /** k8s.node.condition_ready: 1 → true, 0 → false, -1 or absent → null. */
  ready: boolean | null;
  /** k8s.node.condition_memory_pressure, same decode. */
  memoryPressure: boolean | null;
  cpuUsageCores: number | null;
  cpuAllocatableCores: number | null;
  memWorkingSetBytes: number | null;
  memAvailableBytes: number | null;
  memAllocatableBytes: number | null;
  /** Distinct fresh pods whose k8s.node.name is this node. */
  podCount: number;
  /** ISO time of the newest fresh bucket among this node's series. */
  lastSeen: string;
}

export type PodPhase = "pending" | "running" | "succeeded" | "failed" | "unknown";

export interface InfraPod {
  namespace: string;
  name: string;
  node: string | null;
  /** k8s.pod.phase 1..5 → pending|running|succeeded|failed|unknown; absent → null. */
  phase: PodPhase | null;
  /** Sum of k8s.container.restarts over the pod's fresh containers; no cluster leg → null. */
  restarts: number | null;
  cpuUsageCores: number | null;
  /** Sum of the containers' latest cpu_limit; null unless EVERY container with fresh
   *  container.cpu.usage also has a fresh k8s.container.cpu_limit (D457). */
  cpuLimitCores: number | null;
  memWorkingSetBytes: number | null;
  /** Same completeness rule over memory_limit / container.memory.working_set. */
  memLimitBytes: number | null;
  lastSeen: string;
}

export type RecKind = "memory-limit-oversized" | "memory-near-limit" | "cpu-near-limit";

/** No price field, by construction: obstack has no price input for compute (D13/D362). */
export interface RightsizingRec {
  namespace: string;
  pod: string;
  container: string;
  kind: RecKind;
  /** Window max of the observed metric (bytes or cores). */
  peak: number;
  /** The container's latest limit (bytes or cores). */
  limit: number;
  /** peak / limit. */
  ratio: number;
  /** Hours between the first and last bucket of the observed series inside the window. */
  observedHours: number;
}

export interface InfraSnapshot {
  nodes: InfraNode[];
  totalNodes: number;
  pods: InfraPod[];
  totalPods: number;
  recs: RightsizingRec[];
  totalRecs: number;
  hasKubeletMetrics: boolean;
  hasClusterMetrics: boolean;
  /** ISO time of the newest fresh bucket across every k8s series; null when nothing is fresh. */
  asOf: string | null;
}
