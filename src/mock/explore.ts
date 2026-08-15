import { NOW } from "./generate";
import { between, mulberry32 } from "./rand";
import type { Layer } from "@/lib/types";

export interface MetricDef {
  id: string;
  name: string;
  layer: Layer;
  unit: string;
  base: number;
  spread: number; // fraction of base, e.g. 0.25
  incidentFactor: number; // multiplier during the 13:05–13:25 incident window
}

export const metricCatalog: MetricDef[] = [
  { id: "api.request_rate", name: "Request rate", layer: "api", unit: "req/min", base: 380, spread: 0.2, incidentFactor: 1.9 },
  { id: "api.error_rate", name: "Error rate", layer: "api", unit: "%", base: 1.1, spread: 0.5, incidentFactor: 12 },
  { id: "api.p95_latency", name: "p95 latency", layer: "api", unit: "ms", base: 2800, spread: 0.25, incidentFactor: 2.8 },
  { id: "api.p50_latency", name: "p50 latency", layer: "api", unit: "ms", base: 450, spread: 0.2, incidentFactor: 2.1 },
  { id: "agent.run_duration", name: "Agent run duration", layer: "agent", unit: "s", base: 14, spread: 0.35, incidentFactor: 2.4 },
  { id: "agent.steps_per_run", name: "Steps per run", layer: "agent", unit: "steps", base: 6.2, spread: 0.3, incidentFactor: 1.7 },
  { id: "agent.loop_aborts", name: "Loop aborts", layer: "agent", unit: "/hr", base: 2.1, spread: 0.8, incidentFactor: 6 },
  { id: "tool.call_latency", name: "Tool call latency", layer: "tool", unit: "ms", base: 620, spread: 0.3, incidentFactor: 2.2 },
  { id: "tool.failure_rate", name: "Tool failure rate", layer: "tool", unit: "%", base: 1.8, spread: 0.5, incidentFactor: 5 },
  { id: "llm.tokens_per_min", name: "Tokens per minute", layer: "llm", unit: "tok/min", base: 265000, spread: 0.25, incidentFactor: 1.6 },
  { id: "llm.cost_per_hour", name: "LLM cost", layer: "llm", unit: "$/hr", base: 14.2, spread: 0.25, incidentFactor: 1.8 },
  { id: "llm.ttft", name: "Time to first token", layer: "llm", unit: "ms", base: 840, spread: 0.3, incidentFactor: 3.1 },
  { id: "infra.cpu", name: "CPU utilization", layer: "infra", unit: "%", base: 54, spread: 0.2, incidentFactor: 1.6 },
  { id: "infra.memory", name: "Memory utilization", layer: "infra", unit: "%", base: 61, spread: 0.12, incidentFactor: 1.3 },
  { id: "infra.pod_restarts", name: "Pod restarts", layer: "infra", unit: "/hr", base: 0.4, spread: 1.2, incidentFactor: 9 },
];

export type GroupBy = "none" | "service" | "model" | "route";

export const groupMembers: Record<Exclude<GroupBy, "none">, string[]> = {
  service: ["gateway", "agent-worker", "tools", "sync-worker"],
  model: ["gpt-5.2", "claude-sonnet-5", "claude-haiku-4.5"],
  route: ["POST /v1/chat", "POST /v1/tickets/{id}/reply", "GET /v1/tickets", "POST /v1/webhooks/zendesk"],
};

export const serviceOptions = ["all", "gateway", "agent-worker", "tools", "sync-worker"];

const GROUP_COLORS = [
  "var(--color-api)",
  "var(--color-agent)",
  "var(--color-tool)",
  "var(--color-llm)",
  "var(--color-infra)",
];

export interface ExploreQuery {
  metricId: string;
  service: string; // "all" or one of serviceOptions
  env: "prod" | "staging";
  groupBy: GroupBy;
  rangeHours: 1 | 6 | 24;
}

export interface ExploreSeries {
  name: string;
  color: string;
  points: { t: string; v: number }[];
}

/** Stable 32-bit hash so every distinct query shape gets its own reproducible seed. */
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

const BUCKETS = 24; // fixed count; rangeHours changes bucket width

export function exploreSeries(q: ExploreQuery): ExploreSeries[] {
  const def = metricCatalog.find((m) => m.id === q.metricId) ?? metricCatalog[0];
  const names = q.groupBy === "none" ? [def.name] : groupMembers[q.groupBy];
  const bucketMs = (q.rangeHours * 3600_000) / BUCKETS;

  return names.map((name, gi) => {
    const rng = mulberry32(hashSeed(`${def.id}|${q.service}|${q.env}|${name}`));
    // each group member gets a stable scale so grouped charts have visible ordering
    const scale = q.groupBy === "none" ? 1 : 0.45 + between(rng, 0, 0.9);
    const envScale = q.env === "prod" ? 1 : 0.18;
    const points = [];
    for (let i = BUCKETS - 1; i >= 0; i--) {
      const t = NOW - i * bucketMs;
      // incident window: 13:05–13:25 UTC on the NOW anchor day, visible in 6h/24h ranges
      const inIncident = t >= Date.parse("2026-08-09T13:05:00Z") && t <= Date.parse("2026-08-09T13:25:00Z");
      const noise = 1 + (between(rng, 0, 2) - 1) * def.spread;
      const v = def.base * scale * envScale * noise * (inIncident ? def.incidentFactor : 1);
      points.push({ t: hhmm(t), v: +v.toFixed(def.base < 10 ? 2 : 0) });
    }
    return { name, color: GROUP_COLORS[gi % GROUP_COLORS.length], points };
  });
}
