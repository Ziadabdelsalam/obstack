/** Service-level objectives with error-budget accounting. */

export interface Slo {
  name: string;
  objective: string;
  window: string;
  target: number; // %
  current: number; // %
  budgetBurnedPct: number; // % of error budget consumed this window
  status: "healthy" | "at-risk" | "breached";
  note?: string;
  link: string;
}

export const slos: Slo[] = [
  {
    name: "Chat latency",
    objective: "99% of POST /v1/chat under 2s",
    window: "30d rolling",
    target: 99.0,
    current: 98.4,
    budgetBurnedPct: 84,
    status: "at-risk",
    note: "Today's rate-limit cascade and the kb-reindex window burned 31% of the monthly budget in one afternoon.",
    link: "/app/traces?minMs=1000",
  },
  {
    name: "API availability",
    objective: "99.9% of requests non-5xx",
    window: "30d rolling",
    target: 99.9,
    current: 99.93,
    budgetBurnedPct: 41,
    status: "healthy",
    link: "/app/traces?status=error",
  },
  {
    name: "Agent reply quality",
    objective: "95% of replies with review confidence ≥ 0.70",
    window: "7d rolling",
    target: 95.0,
    current: 96.8,
    budgetBurnedPct: 22,
    status: "healthy",
    note: "Dipped during the 12:55 kb-reindex window (fallback replies), recovered since.",
    link: "/app/evals",
  },
  {
    name: "Pipeline freshness",
    objective: "sync-tickets lag under 60s for 99.5% of minutes",
    window: "30d rolling",
    target: 99.5,
    current: 99.7,
    budgetBurnedPct: 18,
    status: "healthy",
    link: "/app/pipelines",
  },
];
