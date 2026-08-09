import { mulberry32, between } from "./rand";

/** Watch-widget system: what a user can pin to the Overview. */

export type WidgetType =
  | "service"
  | "service-compare"
  | "route"
  | "pod"
  | "model"
  | "tool"
  | "queue";

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  a: string;
  b?: string;
}

export const widgetMeta: Record<
  WidgetType,
  { label: string; description: string; options: string[]; needsB?: boolean }
> = {
  service: {
    label: "Service watch",
    description: "Requests, error rate and p95 for one service",
    options: ["gateway", "agent-worker", "tools", "kb-service", "notifier", "sync-worker"],
  },
  "service-compare": {
    label: "Service comparison",
    description: "Request volume of two services, overlaid",
    options: ["gateway", "agent-worker", "tools", "kb-service", "notifier", "sync-worker"],
    needsB: true,
  },
  route: {
    label: "Route latency",
    description: "p50/p95 for one API route",
    options: [
      "POST /v1/chat",
      "POST /v1/tickets/{id}/reply",
      "POST /v1/tickets/bulk",
      "GET /v1/tickets",
      "POST /v1/webhooks/zendesk",
    ],
  },
  pod: {
    label: "Pod health",
    description: "Memory, restarts and status for one pod",
    options: [
      "agent-worker-7d9fb-kx2rq",
      "agent-worker-7d9fb-m8xzt",
      "gateway-84c5f-jw6th",
      "kb-service-5c66d-qp4wn",
      "kafka-broker-2",
      "postgres-0",
    ],
  },
  model: {
    label: "Model spend",
    description: "Token volume and cost for one model",
    options: ["claude-sonnet-5", "claude-haiku-4-5", "loopwork-ft-classifier"],
  },
  tool: {
    label: "Tool errors",
    description: "Calls, errors and timeout rate for one tool",
    options: ["search_kb", "fetch_customer", "update_ticket"],
  },
  queue: {
    label: "Queue lag",
    description: "Consumer lag and throughput for one topic",
    options: ["ticket-events", "email-outbox", "audit-log"],
  },
};

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return h >>> 0;
}

/** Deterministic 24-point series for any entity, stable across renders. */
export function seriesFor(key: string, base: number, spread: number): number[] {
  const rng = mulberry32(hash(key));
  const out: number[] = [];
  let v = base + between(rng, -spread / 3, spread / 3);
  for (let i = 0; i < 24; i++) {
    v += between(rng, -spread / 4, spread / 4);
    v = Math.max(base - spread, Math.min(base + spread, v));
    out.push(Math.round(v * 100) / 100);
  }
  return out;
}

export function widgetTitle(c: WidgetConfig): string {
  return c.type === "service-compare" ? `${c.a} vs ${c.b}` : c.a;
}

export interface WidgetStat {
  label: string;
  value: string;
  tone?: "ok" | "warn" | "err";
}

export function statsFor(c: WidgetConfig): WidgetStat[] {
  const rng = mulberry32(hash(c.type + c.a));
  switch (c.type) {
    case "service":
      return [
        { label: "req/min", value: Math.round(between(rng, 40, 900)).toLocaleString() },
        {
          label: "errors",
          value: `${between(rng, 0.2, 3.4).toFixed(1)}%`,
          tone: rng() > 0.7 ? "warn" : "ok",
        },
        { label: "p95", value: `${between(rng, 0.4, 4.2).toFixed(1)}s` },
      ];
    case "service-compare":
      return [
        { label: c.a, value: `${Math.round(between(rng, 100, 800))}/min` },
        { label: c.b ?? "", value: `${Math.round(between(rng, 100, 800))}/min` },
      ];
    case "route":
      return [
        { label: "p50", value: `${Math.round(between(rng, 60, 900))}ms` },
        { label: "p95", value: `${between(rng, 1.2, 6.8).toFixed(1)}s` },
        { label: "req · 6h", value: Math.round(between(rng, 400, 4000)).toLocaleString() },
      ];
    case "pod": {
      const rss = Math.round(between(rng, 180, 490));
      return [
        { label: "rss", value: `${rss}Mi / 512Mi`, tone: rss > 440 ? "warn" : "ok" },
        {
          label: "restarts · 24h",
          value: String(Math.round(between(rng, 0, 3))),
          tone: rng() > 0.6 ? "warn" : "ok",
        },
        { label: "cpu", value: `${Math.round(between(rng, 8, 84))}%` },
      ];
    }
    case "model":
      return [
        { label: "tokens · today", value: `${between(rng, 0.4, 6.2).toFixed(1)}M` },
        { label: "cost · today", value: `$${between(rng, 4, 68).toFixed(2)}` },
        { label: "calls", value: Math.round(between(rng, 800, 9000)).toLocaleString() },
      ];
    case "tool":
      return [
        { label: "calls · 6h", value: Math.round(between(rng, 300, 4200)).toLocaleString() },
        {
          label: "errors",
          value: String(Math.round(between(rng, 0, 14))),
          tone: rng() > 0.5 ? "warn" : "ok",
        },
        { label: "timeout rate", value: `${between(rng, 0, 2.4).toFixed(1)}%` },
      ];
    case "queue":
      return [
        {
          label: "lag",
          value: Math.round(between(rng, 0, 240)).toLocaleString(),
          tone: rng() > 0.7 ? "warn" : "ok",
        },
        { label: "in", value: `${Math.round(between(rng, 40, 400))}/min` },
        { label: "out", value: `${Math.round(between(rng, 40, 400))}/min` },
      ];
  }
}

/** Default pinned widgets for first-time visitors. */
export const defaultWidgets: WidgetConfig[] = [
  { id: "w-default-1", type: "service", a: "agent-worker" },
  { id: "w-default-2", type: "pod", a: "agent-worker-7d9fb-kx2rq" },
];
