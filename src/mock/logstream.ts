import { NOW } from "./generate";
import { between, mulberry32, pick } from "./rand";
import { allTraces } from "./traces";
import type { Severity } from "./types";

/** A flattened, absolute-time log entry for the Logs explorer. */
export interface StreamLog {
  id: string;
  ts: number; // absolute epoch ms
  severity: Severity;
  body: string;
  namespace: string;
  pod: string;
  container: string;
  traceId?: string;
}

const AMBIENT: { severity: Severity; body: string; pod: string; container?: string }[] = [
  { severity: "info", body: "Scaled deployment agent-worker 3 → 4 replicas (HPA: cpu 82%)", pod: "hpa-controller", container: "kube-system" },
  { severity: "info", body: "cronjob ticket-digest completed in 41s (exit 0)", pod: "ticket-digest-29184730-x2c8f" },
  { severity: "debug", body: "connection pool: 14/20 in use, 0 waiting", pod: "gateway-84c5f-jw6th" },
  { severity: "info", body: "compacted topic ticket-events: 18,422 → 12,014 messages", pod: "kafka-broker-2" },
  { severity: "warn", body: "certificate loopwork.ai expires in 21 days — renewal scheduled", pod: "cert-manager-5f6d8-qq2lp", container: "cert-manager" },
  { severity: "debug", body: "healthz ok (uptime 14d2h)", pod: "tools-6b6f4-w9qp2" },
  { severity: "info", body: "vacuum analyze tickets: 84,211 rows, 2.1s", pod: "postgres-0", container: "postgres" },
  { severity: "warn", body: "slow query 1.9s: SELECT ... FROM ticket_events WHERE payload @> $1", pod: "postgres-0", container: "postgres" },
  { severity: "info", body: "redis: evicted 1,204 keys (maxmemory-policy allkeys-lru)", pod: "redis-master-0", container: "redis" },
  { severity: "debug", body: "ws: 214 active connections across 41 workspaces", pod: "notifier-6d98c-v7slj" },
];

function buildStream(): StreamLog[] {
  const out: StreamLog[] = [];
  // correlated logs from every trace, stamped with absolute time
  for (const t of allTraces) {
    const start = Date.parse(t.startedAt);
    for (const l of t.logs) {
      out.push({
        id: l.id,
        ts: start + l.atMs,
        severity: l.severity,
        body: l.body,
        namespace: l.namespace,
        pod: l.pod,
        container: l.container,
        traceId: l.traceId,
      });
    }
  }
  // ambient cluster noise, spread over the same 6h window
  const rng = mulberry32(777);
  for (let i = 0; i < 90; i++) {
    const a = pick(rng, AMBIENT);
    out.push({
      id: `amb-${i}`,
      ts: NOW - Math.round(between(rng, 0, 6 * 3600_000)),
      severity: a.severity,
      body: a.body,
      namespace: "loopwork-prod",
      pod: a.pod,
      container: a.container ?? "app",
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

export const streamLogs: StreamLog[] = buildStream();

export const podOptions: string[] = [
  ...new Set(streamLogs.map((l) => l.pod)),
].sort();
