import type { GroupBy } from "./explore";

export type WidgetKind = "timeseries" | "stat" | "topn" | "table";

export interface Widget {
  id: string;
  title: string;
  kind: WidgetKind;
  metricId: string; // from metricCatalog
  groupBy: GroupBy;
}

export interface Dashboard {
  id: string;
  name: string;
  owner: string;
  updated: string;
  widgets: Widget[];
}

export const seedDashboards: Dashboard[] = [
  {
    id: "ai-overview",
    name: "AI Overview",
    owner: "AI",
    updated: "2h ago",
    widgets: [
      { id: "w1", title: "Tokens per minute", kind: "timeseries", metricId: "llm.tokens_per_min", groupBy: "model" },
      { id: "w2", title: "LLM cost", kind: "stat", metricId: "llm.cost_per_hour", groupBy: "none" },
      { id: "w3", title: "Time to first token", kind: "timeseries", metricId: "llm.ttft", groupBy: "model" },
      { id: "w4", title: "Agent run duration", kind: "timeseries", metricId: "agent.run_duration", groupBy: "none" },
      { id: "w5", title: "Loop aborts", kind: "stat", metricId: "agent.loop_aborts", groupBy: "none" },
      { id: "w6", title: "Tool failures by service", kind: "topn", metricId: "tool.failure_rate", groupBy: "service" },
    ],
  },
  {
    id: "checkout-golden",
    name: "Checkout Golden Signals",
    owner: "Platform",
    updated: "yesterday",
    widgets: [
      { id: "w1", title: "Request rate", kind: "timeseries", metricId: "api.request_rate", groupBy: "route" },
      { id: "w2", title: "Error rate", kind: "timeseries", metricId: "api.error_rate", groupBy: "none" },
      { id: "w3", title: "p95 latency", kind: "timeseries", metricId: "api.p95_latency", groupBy: "none" },
      { id: "w4", title: "p50 latency", kind: "stat", metricId: "api.p50_latency", groupBy: "none" },
      { id: "w5", title: "Routes by traffic", kind: "table", metricId: "api.request_rate", groupBy: "route" },
    ],
  },
  {
    id: "infra-capacity",
    name: "Infra Capacity",
    owner: "Infra",
    updated: "3d ago",
    widgets: [
      { id: "w1", title: "CPU by service", kind: "timeseries", metricId: "infra.cpu", groupBy: "service" },
      { id: "w2", title: "Memory by service", kind: "timeseries", metricId: "infra.memory", groupBy: "service" },
      { id: "w3", title: "Pod restarts", kind: "stat", metricId: "infra.pod_restarts", groupBy: "none" },
      { id: "w4", title: "Hottest services", kind: "topn", metricId: "infra.cpu", groupBy: "service" },
    ],
  },
  {
    id: "llm-cost-tokens",
    name: "LLM Cost & Tokens",
    owner: "AI",
    updated: "5d ago",
    widgets: [
      { id: "w1", title: "Cost per hour", kind: "timeseries", metricId: "llm.cost_per_hour", groupBy: "model" },
      { id: "w2", title: "Tokens per minute", kind: "stat", metricId: "llm.tokens_per_min", groupBy: "none" },
      { id: "w3", title: "Cost by model", kind: "table", metricId: "llm.cost_per_hour", groupBy: "model" },
    ],
  },
];
