import type { Layer } from "@/lib/types";

export interface ServiceEntry {
  id: string;
  name: string;
  layer: Layer;
  team: "Platform" | "AI" | "Infra";
  tier: 1 | 2 | 3;
  runtime: string;
  deps: string[];
  sloStatus: "healthy" | "at-risk" | "breached" | "none";
  score: { coverage: boolean; alerts: boolean; runbook: boolean; slo: boolean };
}

export function grade(s: ServiceEntry): "A" | "B" | "C" | "D" {
  const n = Object.values(s.score).filter(Boolean).length;
  return (["D", "C", "B", "A"] as const)[Math.max(0, n - 1)];
}

export const services: ServiceEntry[] = [
  {
    id: "gateway", name: "gateway", layer: "api", team: "Platform", tier: 1, runtime: "node 24",
    deps: ["agent-worker", "postgres", "redis"], sloStatus: "at-risk",
    score: { coverage: true, alerts: true, runbook: true, slo: true },
  },
  {
    id: "agent-worker", name: "agent-worker", layer: "agent", team: "AI", tier: 1, runtime: "python 3.13",
    deps: ["tools", "llm-router", "redis"], sloStatus: "at-risk",
    score: { coverage: true, alerts: true, runbook: true, slo: true },
  },
  {
    id: "tools", name: "tools", layer: "tool", team: "AI", tier: 2, runtime: "python 3.13",
    deps: ["postgres", "vector-db"], sloStatus: "healthy",
    score: { coverage: true, alerts: true, runbook: false, slo: true },
  },
  {
    id: "llm-router", name: "llm-router", layer: "llm", team: "AI", tier: 1, runtime: "node 24",
    deps: [], sloStatus: "healthy",
    score: { coverage: true, alerts: true, runbook: false, slo: false },
  },
  {
    id: "sync-worker", name: "sync-worker", layer: "agent", team: "Platform", tier: 3, runtime: "python 3.13",
    deps: ["postgres", "gateway"], sloStatus: "none",
    score: { coverage: true, alerts: false, runbook: false, slo: false },
  },
  {
    id: "postgres", name: "postgres", layer: "infra", team: "Infra", tier: 1, runtime: "pg 17 (managed)",
    deps: [], sloStatus: "healthy",
    score: { coverage: true, alerts: true, runbook: true, slo: false },
  },
  {
    id: "redis", name: "redis", layer: "infra", team: "Infra", tier: 2, runtime: "redis 8 (managed)",
    deps: [], sloStatus: "healthy",
    score: { coverage: true, alerts: false, runbook: true, slo: false },
  },
  {
    id: "vector-db", name: "vector-db", layer: "infra", team: "Infra", tier: 2, runtime: "qdrant 1.12",
    deps: [], sloStatus: "none",
    score: { coverage: false, alerts: false, runbook: false, slo: false },
  },
];
