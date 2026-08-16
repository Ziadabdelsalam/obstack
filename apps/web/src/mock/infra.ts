/** Kubernetes inventory: nodes and pods with health, joined to logs and traces. */

export interface K8sNode {
  name: string;
  pool: string;
  cpuPct: number;
  memPct: number;
  pods: number;
  status: "ready" | "pressure";
}

export const nodes: K8sNode[] = [
  { name: "gke-prod-pool1-a3f2", pool: "pool1 · e2-standard-4", cpuPct: 46, memPct: 58, pods: 14, status: "ready" },
  { name: "gke-prod-pool1-f21a", pool: "pool1 · e2-standard-4", cpuPct: 38, memPct: 44, pods: 11, status: "ready" },
  { name: "gke-prod-pool2-b7c9", pool: "pool2 · n2-highmem-4", cpuPct: 71, memPct: 86, pods: 9, status: "pressure" },
  { name: "gke-prod-pool3-d4e8", pool: "pool3 · n2-standard-8 (kafka)", cpuPct: 52, memPct: 61, pods: 6, status: "ready" },
];

export interface K8sPod {
  name: string;
  service: string;
  node: string;
  status: "running" | "crashloop" | "pending";
  restarts24h: number;
  rssMi: number;
  limitMi: number;
  cpuPct: number;
  age: string;
}

export const pods: K8sPod[] = [
  { name: "agent-worker-7d9fb-kx2rq", service: "agent-worker", node: "gke-prod-pool2-b7c9", status: "running", restarts24h: 3, rssMi: 492, limitMi: 512, cpuPct: 64, age: "2d" },
  { name: "agent-worker-7d9fb-m8xzt", service: "agent-worker", node: "gke-prod-pool2-b7c9", status: "running", restarts24h: 0, rssMi: 361, limitMi: 512, cpuPct: 41, age: "2d" },
  { name: "agent-worker-7d9fb-p2vnc", service: "agent-worker", node: "gke-prod-pool2-b7c9", status: "running", restarts24h: 0, rssMi: 344, limitMi: 512, cpuPct: 38, age: "6h" },
  { name: "gateway-84c5f-jw6th", service: "gateway", node: "gke-prod-pool1-a3f2", status: "running", restarts24h: 0, rssMi: 187, limitMi: 512, cpuPct: 22, age: "6d" },
  { name: "gateway-84c5f-r2d8m", service: "gateway", node: "gke-prod-pool1-f21a", status: "running", restarts24h: 0, rssMi: 179, limitMi: 512, cpuPct: 19, age: "6d" },
  { name: "tools-6b6f4-w9qp2", service: "tools", node: "gke-prod-pool1-a3f2", status: "running", restarts24h: 0, rssMi: 244, limitMi: 768, cpuPct: 17, age: "6d" },
  { name: "kb-service-5c66d-qp4wn", service: "kb-service", node: "gke-prod-pool1-f21a", status: "running", restarts24h: 0, rssMi: 601, limitMi: 1024, cpuPct: 55, age: "12d" },
  { name: "sync-worker-59fd7-hh2kq", service: "sync-worker", node: "gke-prod-pool2-b7c9", status: "running", restarts24h: 1, rssMi: 156, limitMi: 384, cpuPct: 12, age: "3d" },
  { name: "notifier-6d98c-v7slj", service: "notifier", node: "gke-prod-pool1-f21a", status: "running", restarts24h: 0, rssMi: 132, limitMi: 256, cpuPct: 8, age: "9d" },
  { name: "kafka-broker-2", service: "kafka", node: "gke-prod-pool3-d4e8", status: "running", restarts24h: 0, rssMi: 3072, limitMi: 4096, cpuPct: 47, age: "31d" },
  { name: "postgres-0", service: "postgres", node: "gke-prod-pool3-d4e8", status: "running", restarts24h: 0, rssMi: 2458, limitMi: 4096, cpuPct: 33, age: "31d" },
  { name: "redis-master-0", service: "redis", node: "gke-prod-pool1-a3f2", status: "running", restarts24h: 0, rssMi: 412, limitMi: 1024, cpuPct: 9, age: "31d" },
];

export const rightsizing = [
  {
    title: "agent-worker: raise memory 512Mi → 1Gi",
    detail: "3 OOM kills in 24h at 96% of limit while streaming. n2-highmem headroom exists on pool2.",
    impact: "prevents the INC-42 class of failure",
  },
  {
    title: "tools: reduce CPU request 500m → 250m",
    detail: "p95 CPU is 17% of request across 30d — you're paying for idle reservation.",
    impact: "~$31/mo compute savings",
  },
  {
    title: "kb-service: schedule reindex off-peak",
    detail: "The 6-hourly reindex at 12:55 collided with lunch traffic and degraded 11 agent runs.",
    impact: "moves risk to 03:55 window",
  },
];
