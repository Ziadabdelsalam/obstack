# Four Product Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Dashboards (with working builder), Metrics Explorer, On-call + Notifications, and Service Catalog surfaces to obstack, tied together by a shared client store so "Save to dashboard" from the explorer genuinely works.

**Architecture:** Four new App Router routes backed by three new mock modules and one shared metric catalog. A React context (`WorkspaceProvider`) holds the only editable state (dashboards, notification channels); everything else is static mock imports like the rest of the app. All generated series use the existing seeded-PRNG pattern so SSR and client render identically.

**Tech Stack:** Next.js 16.3 App Router, React 19, recharts 3, Tailwind 4, lucide-react. No new dependencies.

**Spec:** `.planning/2026-08-10-product-surfaces-design.md`

## Global Constraints

- **Determinism:** NEVER use `Math.random()`, `Date.now()`, or argless `new Date()` in mock data or components. Use `mulberry32`/`between`/`pick` from `src/mock/rand.ts` and the fixed `NOW` anchor from `src/mock/generate.ts`. Violations cause hydration errors.
- **Next 16:** route `params` is a `Promise` — `await params` in server components, `use(params)` (from `"react"`) in client components. If anything else about the framework surprises you, check `node_modules/next/dist/docs/` per AGENTS.md before guessing.
- **Styling idiom (copy from existing pages):** page wrapper `px-5 py-4`; section card `rounded-lg border border-line bg-surface p-3.5`; section heading `font-mono text-[11px] uppercase tracking-widest text-faint`; small mono text `font-mono text-[10.5px] text-faint`. Color tokens: `var(--color-api|agent|tool|llm|infra|err|warn|ok|mid|ink|faint|line)`.
- **Icons:** lucide-react only, matching existing SideNav imports.
- **Verification command:** `npm run build` (includes typecheck). There is no unit-test framework in this repo — each task's gate is a clean build plus browser verification where stated.
- **Existing world:** services are gateway, agent-worker, tools, sync-worker (see `src/mock/generate.ts` pod names). Teams are Platform, AI, Infra. Do not invent new services; reuse these names everywhere.
- **Commits:** one per task, message style matches repo history (short imperative subject).

---

### Task 1: Metric catalog + deterministic series generator (`src/mock/explore.ts`)

**Files:**
- Create: `src/mock/explore.ts`

**Interfaces:**
- Consumes: `mulberry32`, `between` from `src/mock/rand.ts`; `NOW` from `src/mock/generate.ts`; `Layer` from `src/mock/types.ts`
- Produces (used by Tasks 2, 4, 5):
  - `interface MetricDef { id: string; name: string; layer: Layer; unit: string; base: number; spread: number; incidentFactor: number }`
  - `const metricCatalog: MetricDef[]` (15 metrics)
  - `type GroupBy = "none" | "service" | "model" | "route"`
  - `interface ExploreQuery { metricId: string; service: string; env: "prod" | "staging"; groupBy: GroupBy; rangeHours: 1 | 6 | 24 }`
  - `interface ExploreSeries { name: string; color: string; points: { t: string; v: number }[] }`
  - `function exploreSeries(q: ExploreQuery): ExploreSeries[]`
  - `const groupMembers: Record<Exclude<GroupBy, "none">, string[]>`
  - `const serviceOptions: string[]` — `["all", "gateway", "agent-worker", "tools", "sync-worker"]`

- [ ] **Step 1: Write the module**

```ts
import { NOW } from "./generate";
import { between, mulberry32 } from "./rand";
import type { Layer } from "./types";

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
```

- [ ] **Step 2: Verify it builds**

Run: `npm run build`
Expected: build succeeds with no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/mock/explore.ts
git commit -m "Mock: metric catalog + deterministic explore series generator"
```

---

### Task 2: Mock data modules — dashboards, on-call, service catalog

**Files:**
- Create: `src/mock/dashboards.ts`
- Create: `src/mock/oncall.ts`
- Create: `src/mock/catalog.ts`

**Interfaces:**
- Consumes: `GroupBy` from `src/mock/explore.ts`; `Layer` from `src/mock/types.ts`
- Produces (used by Tasks 3–7):
  - dashboards: `type WidgetKind = "timeseries" | "stat" | "topn" | "table"`; `interface Widget { id: string; title: string; kind: WidgetKind; metricId: string; groupBy: GroupBy }`; `interface Dashboard { id: string; name: string; owner: string; updated: string; widgets: Widget[] }`; `const seedDashboards: Dashboard[]`
  - oncall: `interface Rotation { team: string; primary: string; secondary: string; until: string; week: { day: string; primary: string }[] }`; `const rotations: Rotation[]`; `interface EscalationPolicy { id: string; name: string; team: string; steps: string[] }`; `const escalationPolicies: EscalationPolicy[]`; `interface NotificationChannel { id: string; name: string; kind: "slack" | "pagerduty" | "email" | "webhook"; target: string; enabled: boolean }`; `const seedChannels: NotificationChannel[]`; `interface RouteEntry { rule: string; policyId: string; channelIds: string[] }`; `const alertRouting: RouteEntry[]`
  - catalog: `interface ServiceEntry { id: string; name: string; layer: Layer; team: "Platform" | "AI" | "Infra"; tier: 1 | 2 | 3; runtime: string; deps: string[]; sloStatus: "healthy" | "at-risk" | "breached" | "none"; score: { coverage: boolean; alerts: boolean; runbook: boolean; slo: boolean } }`; `function grade(s: ServiceEntry): "A" | "B" | "C" | "D"`; `const services: ServiceEntry[]`

- [ ] **Step 1: Write `src/mock/dashboards.ts`**

```ts
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
```

- [ ] **Step 2: Write `src/mock/oncall.ts`**

```ts
export interface Rotation {
  team: string;
  primary: string;
  secondary: string;
  until: string;
  week: { day: string; primary: string }[];
}

export const rotations: Rotation[] = [
  {
    team: "Platform",
    primary: "Nour El-Sayed",
    secondary: "Ziad Abdelsalam",
    until: "Mon Aug 11, 09:00",
    week: [
      { day: "Mon", primary: "Nour" }, { day: "Tue", primary: "Nour" }, { day: "Wed", primary: "Ziad" },
      { day: "Thu", primary: "Ziad" }, { day: "Fri", primary: "Nour" }, { day: "Sat", primary: "Omar" },
      { day: "Sun", primary: "Omar" },
    ],
  },
  {
    team: "AI",
    primary: "Omar Farouk",
    secondary: "Nour El-Sayed",
    until: "Wed Aug 13, 09:00",
    week: [
      { day: "Mon", primary: "Omar" }, { day: "Tue", primary: "Omar" }, { day: "Wed", primary: "Omar" },
      { day: "Thu", primary: "Nour" }, { day: "Fri", primary: "Nour" }, { day: "Sat", primary: "Ziad" },
      { day: "Sun", primary: "Ziad" },
    ],
  },
  {
    team: "Infra",
    primary: "Ziad Abdelsalam",
    secondary: "Omar Farouk",
    until: "Mon Aug 11, 09:00",
    week: [
      { day: "Mon", primary: "Ziad" }, { day: "Tue", primary: "Ziad" }, { day: "Wed", primary: "Ziad" },
      { day: "Thu", primary: "Omar" }, { day: "Fri", primary: "Omar" }, { day: "Sat", primary: "Nour" },
      { day: "Sun", primary: "Nour" },
    ],
  },
];

export interface EscalationPolicy {
  id: string;
  name: string;
  team: string;
  steps: string[];
}

export const escalationPolicies: EscalationPolicy[] = [
  {
    id: "p-critical",
    name: "Critical — page immediately",
    team: "Platform",
    steps: ["Page primary on-call", "5 min no-ack → page secondary", "15 min no-ack → notify #incidents + team lead"],
  },
  {
    id: "p-ai-degraded",
    name: "AI quality degradation",
    team: "AI",
    steps: ["Notify #ai-quality", "10 min no-ack → page AI primary", "30 min unresolved → open incident"],
  },
  {
    id: "p-infra-batch",
    name: "Infra / batch (business hours)",
    team: "Infra",
    steps: ["Notify #infra", "Business hours only → page Infra primary", "Next morning digest otherwise"],
  },
];

export interface NotificationChannel {
  id: string;
  name: string;
  kind: "slack" | "pagerduty" | "email" | "webhook";
  target: string;
  enabled: boolean;
}

export const seedChannels: NotificationChannel[] = [
  { id: "ch-slack", name: "#incidents", kind: "slack", target: "loopwork.slack.com", enabled: true },
  { id: "ch-pd", name: "PagerDuty", kind: "pagerduty", target: "loopwork.pagerduty.com", enabled: true },
  { id: "ch-email", name: "Email digest", kind: "email", target: "oncall@loopwork.ai", enabled: false },
  { id: "ch-webhook", name: "Ops webhook", kind: "webhook", target: "https://hooks.loopwork.ai/obstack", enabled: false },
];

/** Maps existing alertRules (src/mock/intelligence.ts, matched by name) to policies + channels. */
export interface RouteEntry {
  rule: string;
  policyId: string;
  channelIds: string[];
}

export const alertRouting: RouteEntry[] = [
  { rule: "Error rate", policyId: "p-critical", channelIds: ["ch-slack", "ch-pd"] },
  { rule: "p95 latency", policyId: "p-critical", channelIds: ["ch-slack", "ch-pd"] },
  { rule: "LLM cost spike", policyId: "p-ai-degraded", channelIds: ["ch-slack", "ch-email"] },
  { rule: "Eval score drop", policyId: "p-ai-degraded", channelIds: ["ch-slack"] },
  { rule: "Queue depth", policyId: "p-infra-batch", channelIds: ["ch-slack", "ch-webhook"] },
];
```

Note: before finalizing `alertRouting`, read `src/mock/intelligence.ts` `alertRules` and use the actual rule `name` values verbatim (the five above are a best guess — match them to whatever exists; add/drop rows so every real rule appears exactly once).

- [ ] **Step 3: Write `src/mock/catalog.ts`**

```ts
import type { Layer } from "./types";

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
```

- [ ] **Step 4: Verify build, commit**

Run: `npm run build` → succeeds.

```bash
git add src/mock/dashboards.ts src/mock/oncall.ts src/mock/catalog.ts
git commit -m "Mock: dashboards, on-call, and service catalog data"
```

---

### Task 3: Workspace store + provider wiring

**Files:**
- Create: `src/state/workspace-store.tsx`
- Modify: `src/app/app/layout.tsx` (wrap children)

**Interfaces:**
- Consumes: `Dashboard`, `Widget`, `seedDashboards` from `src/mock/dashboards.ts`; `NotificationChannel`, `seedChannels` from `src/mock/oncall.ts`
- Produces (used by Tasks 4–6):
  - `function WorkspaceProvider({ children }): JSX`
  - `function useWorkspace(): { dashboards: Dashboard[]; createDashboard(name: string): string; addWidget(dashboardId: string, w: Omit<Widget, "id">): void; removeWidget(dashboardId: string, widgetId: string): void; moveWidget(dashboardId: string, widgetId: string, dir: "up" | "down"): void; channels: NotificationChannel[]; toggleChannel(id: string): void }`

- [ ] **Step 1: Write the store**

```tsx
"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";
import { seedDashboards, type Dashboard, type Widget } from "@/mock/dashboards";
import { seedChannels, type NotificationChannel } from "@/mock/oncall";

interface WorkspaceState {
  dashboards: Dashboard[];
  createDashboard: (name: string) => string;
  addWidget: (dashboardId: string, w: Omit<Widget, "id">) => void;
  removeWidget: (dashboardId: string, widgetId: string) => void;
  moveWidget: (dashboardId: string, widgetId: string, dir: "up" | "down") => void;
  channels: NotificationChannel[];
  toggleChannel: (id: string) => void;
}

const Ctx = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [dashboards, setDashboards] = useState<Dashboard[]>(seedDashboards);
  const [channels, setChannels] = useState<NotificationChannel[]>(seedChannels);
  const counter = useRef(0); // monotonic ids — no Math.random (determinism rule)

  const createDashboard = useCallback((name: string) => {
    const id = `custom-${++counter.current}`;
    setDashboards((ds) => [...ds, { id, name, owner: "You", updated: "just now", widgets: [] }]);
    return id;
  }, []);

  const addWidget = useCallback((dashboardId: string, w: Omit<Widget, "id">) => {
    setDashboards((ds) =>
      ds.map((d) =>
        d.id === dashboardId
          ? { ...d, updated: "just now", widgets: [...d.widgets, { ...w, id: `wu-${++counter.current}` }] }
          : d,
      ),
    );
  }, []);

  const removeWidget = useCallback((dashboardId: string, widgetId: string) => {
    setDashboards((ds) =>
      ds.map((d) =>
        d.id === dashboardId ? { ...d, widgets: d.widgets.filter((w) => w.id !== widgetId) } : d,
      ),
    );
  }, []);

  const moveWidget = useCallback((dashboardId: string, widgetId: string, dir: "up" | "down") => {
    setDashboards((ds) =>
      ds.map((d) => {
        if (d.id !== dashboardId) return d;
        const i = d.widgets.findIndex((w) => w.id === widgetId);
        const j = dir === "up" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= d.widgets.length) return d;
        const widgets = [...d.widgets];
        [widgets[i], widgets[j]] = [widgets[j], widgets[i]];
        return { ...d, widgets };
      }),
    );
  }, []);

  const toggleChannel = useCallback((id: string) => {
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)));
  }, []);

  return (
    <Ctx.Provider
      value={{ dashboards, createDashboard, addWidget, removeWidget, moveWidget, channels, toggleChannel }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return v;
}
```

- [ ] **Step 2: Wire into `src/app/app/layout.tsx`**

Add `import { WorkspaceProvider } from "@/state/workspace-store";` and wrap the existing root div:

```tsx
return (
  <WorkspaceProvider>
    <div className="flex h-screen overflow-hidden">
      {/* ...existing content unchanged... */}
    </div>
  </WorkspaceProvider>
);
```

(The layout stays a server component; a client provider rendering server `children` is the standard pattern.)

- [ ] **Step 3: Verify build, commit**

Run: `npm run build` → succeeds.

```bash
git add src/state/workspace-store.tsx src/app/app/layout.tsx
git commit -m "Workspace store: editable dashboards + notification channels"
```

---

### Task 4: Dashboards surface (`/app/dashboards`, `/app/dashboards/[id]`)

**Files:**
- Create: `src/app/app/dashboards/page.tsx` (client — reads store)
- Create: `src/app/app/dashboards/[id]/page.tsx` (client — reads store, edit mode)
- Create: `src/components/dashboards/WidgetCard.tsx`
- Create: `src/components/dashboards/AddWidgetModal.tsx`

**Interfaces:**
- Consumes: `useWorkspace()` (Task 3); `exploreSeries`, `metricCatalog` (Task 1); `Widget`, `WidgetKind` (Task 2); `LayerChip` from `src/components/ui/LayerChip.tsx`
- Produces (used by Task 5): `WidgetCard({ widget }: { widget: Widget })` — renders any widget kind from a `Widget` value; `AddWidgetModal({ onAdd, onClose }: { onAdd: (w: Omit<Widget, "id">) => void; onClose: () => void })`

- [ ] **Step 1: Write `WidgetCard.tsx`**

`"use client"`. Renders by `kind`, always calling `exploreSeries({ metricId: widget.metricId, service: "all", env: "prod", groupBy: widget.groupBy, rangeHours: 6 })`:

- `timeseries`: recharts `LineChart` (~150px tall, `ResponsiveContainer`) with one `Line` per series (`dataKey="v"`, `stroke={s.color}`, `dot={false}`, `strokeWidth={1.5}`); X axis from `points[].t` shown sparsely (`interval={5}`), mono 10px tick style copied from `src/components/dash/Charts.tsx`. Merge series into one data array: `series[0].points.map((p, i) => ({ t: p.t, ...Object.fromEntries(series.map(s => [s.name, s.points[i].v])) }))` and one `Line` per `s.name`.
- `stat`: big number = last point of series 0 (`text-2xl font-semibold`), unit + delta vs first point (`+X%` colored `var(--color-err)` if up and metric is latency/error/cost-ish, else `var(--color-ok)` — decide by `unit` being one of `%`, `ms`, `$/hr`, `/hr`).
- `topn`: average each series' points, sort desc, top 5 as horizontal bars (plain divs: label, bar `div` with `width: pct%` and `background: s.color`, value).
- `table`: same aggregates as rows: name / avg / max / last, mono 10.5px.

Card chrome: `rounded-lg border border-line bg-surface p-3.5`, title in section-heading style, optional edit controls slot via props `editing?: boolean; onRemove?: () => void; onMove?: (dir: "up" | "down") => void` rendered as small icon buttons (`X`, `ArrowUp`, `ArrowDown` from lucide) in the header row.

- [ ] **Step 2: Write `AddWidgetModal.tsx`**

`"use client"`. Fixed overlay (`fixed inset-0 z-50 bg-black/60`, click-outside → `onClose`, matching CommandPalette overlay idiom). Panel lists `metricCatalog` rows (name + `LayerChip layer` + unit); selecting a metric shows kind picker (4 buttons: timeseries / stat / topn / table) and group-by picker (`none / service / model / route`). "Add widget" button calls `onAdd({ title: metric.name, kind, metricId: metric.id, groupBy })` then `onClose()`.

- [ ] **Step 3: Write list page `src/app/app/dashboards/page.tsx`**

`"use client"`. Header row: title "Dashboards" + `New dashboard` button (lucide `Plus`). Grid of cards (`grid gap-3 md:grid-cols-2 lg:grid-cols-3`): each links to `/app/dashboards/${d.id}`, shows name, owner, `updated`, widget count. New-dashboard flow: `const id = createDashboard("Untitled dashboard"); router.push(\`/app/dashboards/${id}\`)` (`useRouter` from `next/navigation`).

- [ ] **Step 4: Write detail page `src/app/app/dashboards/[id]/page.tsx`**

```tsx
"use client";
import { use, useState } from "react";
```

`const { id } = use(params)` (params typed `Promise<{ id: string }>`). Find dashboard in `useWorkspace().dashboards`; if missing render not-found card with link back to `/app/dashboards`. Header: dashboard name, owner/updated line, `Edit`/`Done` toggle button, and (in edit mode) `Add widget` button opening `AddWidgetModal`. Grid `grid gap-3 md:grid-cols-2`; each widget rendered via `WidgetCard` with `editing`, `onRemove={() => removeWidget(id, w.id)}`, `onMove={(dir) => moveWidget(id, w.id, dir)}`. Empty dashboard → dashed-border placeholder tile prompting "Add your first widget".

- [ ] **Step 5: Verify in browser**

Run: `npm run build` → succeeds. Start `npm run dev` (or reuse a running dev server), open `/app/dashboards`:
- 4 seeded dashboards visible; open "AI Overview" → 6 widgets render with charts.
- Edit mode: remove a widget (disappears), move one up (reorders), add a widget via modal (appears).
- "New dashboard" navigates to an empty dashboard.
- Browser console: no hydration warnings.

- [ ] **Step 6: Commit**

```bash
git add src/app/app/dashboards src/components/dashboards
git commit -m "Dashboards: list + builder with add/remove/reorder widgets"
```

---

### Task 5: Metrics explorer (`/app/explore`)

**Files:**
- Create: `src/app/app/explore/page.tsx` (client)
- Create: `src/components/explore/ExploreChart.tsx`
- Create: `src/components/explore/SaveToDashboardModal.tsx`

**Interfaces:**
- Consumes: `metricCatalog`, `exploreSeries`, `groupMembers`, `serviceOptions`, `ExploreQuery`, `GroupBy` (Task 1); `useWorkspace()` (Task 3); `WidgetKind` (Task 2); `LayerChip`
- Produces: nothing consumed later.

- [ ] **Step 1: Write `ExploreChart.tsx`**

`"use client"`. Props: `{ query: ExploreQuery; chartType: "line" | "area" | "bar" }`. Computes `exploreSeries(query)` (wrap in `useMemo` keyed on inputs), merges to one data array (same merge as WidgetCard), renders recharts `LineChart` / `AreaChart` / `BarChart` (~320px tall) with one mark per series, legend row underneath (colored dot + name, mono 10.5px), Y-axis with unit label. Tick/tooltip styling copied from `src/components/dash/Charts.tsx`.

- [ ] **Step 2: Write `SaveToDashboardModal.tsx`**

`"use client"`. Props: `{ onPick: (dashboardId: string) => void; onClose: () => void }`. Overlay + panel listing `useWorkspace().dashboards` (name + widget count); clicking a row calls `onPick(d.id)` then `onClose()`.

- [ ] **Step 3: Write `src/app/app/explore/page.tsx`**

`"use client"`. Layout: left rail (w-60, metric catalog grouped by layer — button per metric, active state `bg-raised`) + main area.

Main area top controls (chip/button groups, mono 10.5px):
- service: `serviceOptions`
- env: prod / staging
- group by: none / service / model / route
- range: 1h / 6h / 24h
- chart: line / area / bar

State: one `useState<ExploreQuery>` (init: first metric, `service:"all"`, `env:"prod"`, `groupBy:"none"`, `rangeHours:6`) plus `chartType`. Below controls: `ExploreChart`, then "Save to dashboard" button (lucide `Plus`).

Save flow: modal → `onPick(dashId)` → `addWidget(dashId, { title: \`${metric.name}${query.groupBy !== "none" ? ` by ${query.groupBy}` : ""}\`, kind: chartType === "bar" ? "topn" : "timeseries", metricId: query.metricId, groupBy: query.groupBy })` → set toast state `{ dashboardId, dashboardName }`. Toast: fixed bottom-right card (`fixed bottom-4 right-4 z-50 rounded-lg border border-line bg-overlay px-4 py-3`), text "Widget saved to {name}" + `<Link href={/app/dashboards/${id}}>View</Link>`; auto-dismiss via `useEffect` `setTimeout` 5s (timers are fine — only mock *data* must be deterministic).

- [ ] **Step 4: Verify in browser**

`npm run build` → succeeds. In dev server, open `/app/explore`:
- Switching metric/filters/group-by/range/chart-type re-renders instantly, stable across reloads.
- Save to "AI Overview" → toast appears → follow link → new widget is on the dashboard.
- No hydration warnings.

- [ ] **Step 5: Commit**

```bash
git add src/app/app/explore src/components/explore
git commit -m "Metrics explorer: query controls + save-to-dashboard flow"
```

---

### Task 6: On-call & notifications (`/app/oncall`)

**Files:**
- Create: `src/app/app/oncall/page.tsx` (server component)
- Create: `src/components/oncall/ChannelToggles.tsx` (client island)

**Interfaces:**
- Consumes: `rotations`, `escalationPolicies`, `alertRouting`, `seedChannels` types (Task 2); `alertRules` from `src/mock/intelligence.ts`; `useWorkspace()` (Task 3)
- Produces: nothing consumed later.

- [ ] **Step 1: Write `ChannelToggles.tsx`**

`"use client"`. Renders `useWorkspace().channels` as rows: kind icon (lucide: `Hash` slack, `Siren` pagerduty, `Mail` email, `Webhook` webhook), name, target (mono faint), and a toggle button — pill `w-8 h-[18px] rounded-full` with a sliding dot, `background: var(--color-ok)` when enabled / `bg-raised` when not, `aria-pressed`, onClick `toggleChannel(c.id)`.

- [ ] **Step 2: Write `src/app/app/oncall/page.tsx`**

Server component, `px-5 py-4`, five section cards:

1. **Now on call** — 3-column grid, one card per `rotations` entry: team name (heading style), primary (ink, with a `var(--color-ok)` dot), "secondary: {name}", "until {until}" (faint mono).
2. **Rotation schedule** — per team a 7-cell strip (`grid grid-cols-7`): day label + primary first-name; today's cell (Sun, since NOW anchor is Sunday Aug 9) outlined `border-line-strong`.
3. **Escalation policies** — one row per policy: name + team chip, steps rendered as `step → step → step` sequence (mono 10.5px, arrows in faint).
4. **Notification channels** — `<ChannelToggles />`.
5. **Alert routing** — table: rule (from `alertRouting`, cross-checked against `alertRules` names), policy name (lookup in `escalationPolicies`), channel names (lookup in `seedChannels`, comma-joined). Footer link "Manage rules → /app/alerts".

- [ ] **Step 3: Verify in browser**

`npm run build` → succeeds. Open `/app/oncall`: all five sections render; toggling a channel flips its pill state.

- [ ] **Step 4: Commit**

```bash
git add src/app/app/oncall src/components/oncall
git commit -m "On-call: rotations, escalation policies, channels, alert routing"
```

---

### Task 7: Service catalog (`/app/services`, `/app/services/[id]`)

**Files:**
- Create: `src/app/app/services/page.tsx` (server component)
- Create: `src/app/app/services/[id]/page.tsx` (server component)

**Interfaces:**
- Consumes: `services`, `grade`, `ServiceEntry` (Task 2); `deploys` from `src/mock/intelligence.ts`; `LayerChip` from `src/components/ui/LayerChip.tsx`
- Produces: nothing consumed later.

- [ ] **Step 1: Write list page**

Server component. Header ("Service catalog", count of services + how many grade A). Table (idiom: look at `/app/users/page.tsx` for table markup): columns Service (link to `/app/services/${s.id}`) · Layer (`LayerChip`) · Team · Tier (`T1`–`T3` mono) · Runtime · Deps (count) · SLO (colored dot + label: ok/warn/err/faint by status) · Grade (mono badge: A `var(--color-ok)`, B `var(--color-infra)`, C `var(--color-warn)`, D `var(--color-err)`).

- [ ] **Step 2: Write detail page**

Server component; `const { id } = await params` (`params: Promise<{ id: string }>`). Unknown id → not-found card linking back to `/app/services`. Sections:

1. **Header** — name, `LayerChip`, team, tier, runtime, grade badge.
2. **Scorecard** — 4 rows (`Telemetry coverage`, `Alerts configured`, `Runbook linked`, `SLO defined`) from `s.score`, each with lucide `Check`/`X` in ok/err color; overall "n/4 checks passing".
3. **Dependencies** — chips for each dep, each linking to `/app/services/${dep}` when the dep exists in `services`, plain chip otherwise; footer link "View on map → /app/map".
4. **Recent deploys** — reuse `deploys` from `src/mock/intelligence.ts` (top 3): sha (mono), time, author, regression flag in err color when `regression`.
5. **Links** — inline links to `/app/slos`, `/app/incidents`, `/app/traces`.

- [ ] **Step 3: Verify in browser**

`npm run build` → succeeds. `/app/services` table renders 8 services; clicking gateway opens its detail; unknown URL `/app/services/nope` shows not-found card.

- [ ] **Step 4: Commit**

```bash
git add src/app/app/services
git commit -m "Service catalog: directory table + per-service scorecard"
```

---

### Task 8: Navigation wiring + end-to-end verification

**Files:**
- Modify: `src/components/shell/SideNav.tsx` (items array, ~lines 39–55)
- Modify: `src/components/shell/CommandPalette.tsx` (routes array, ~lines 15–37)

**Interfaces:**
- Consumes: routes created in Tasks 4–7.
- Produces: final surface reachable from nav + ⌘K.

- [ ] **Step 1: SideNav entries**

Add to the first section's `items` (imports from lucide-react):
- `{ href: "/app/dashboards", label: "Dashboards", icon: LayoutGrid }` — right after Overview
- `{ href: "/app/services", label: "Services", icon: Boxes }` — right after Map
- `{ href: "/app/explore", label: "Explore", icon: Telescope }` — right after Traces
- `{ href: "/app/oncall", label: "On-call", icon: PhoneCall }` — right after Alerts

Note: Overview uses `exact: true` so `/app/dashboards` won't double-highlight; no change needed there.

- [ ] **Step 2: CommandPalette entries**

Add to `routes` next to their SideNav neighbors:

```ts
{ label: "Dashboards", hint: "page", href: "/app/dashboards" },
{ label: "Explore metrics", hint: "page", href: "/app/explore" },
{ label: "On-call", hint: "page", href: "/app/oncall" },
{ label: "Service catalog", hint: "page", href: "/app/services" },
```

- [ ] **Step 3: Full verification (spec §Testing)**

1. `npm run lint` and `npm run build` → both clean.
2. Playwright against the dev server — screenshot each: `/app/dashboards`, `/app/dashboards/ai-overview`, `/app/explore`, `/app/oncall`, `/app/services`, `/app/services/gateway`.
3. Exercise the three key interactions: (a) dashboards edit mode add + remove + reorder; (b) explorer → save to dashboard → widget visible on target dashboard; (c) channel toggle flips.
4. Check browser console for hydration warnings on every new page (must be none).

- [ ] **Step 4: Commit**

```bash
git add src/components/shell/SideNav.tsx src/components/shell/CommandPalette.tsx
git commit -m "Nav: dashboards, explore, on-call, services in sidenav + palette"
```
