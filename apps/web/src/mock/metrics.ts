import { NOW } from "./generate";
import { mulberry32, between } from "./rand";

export interface MetricPoint {
  t: string; // "13:05"
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  tokens: number;
  costUsd: number;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** 6 hours of 15-minute buckets, with the 13:05 rate-limit incident visible. */
export function timeseries(): MetricPoint[] {
  const rng = mulberry32(42);
  const points: MetricPoint[] = [];
  const buckets = 24;
  for (let i = buckets - 1; i >= 0; i--) {
    const t = NOW - i * 15 * 60_000;
    const hourFactor = 1 + 0.35 * Math.sin((new Date(t).getUTCHours() - 6) / 3.8);
    const incident = i <= 2 && i >= 1; // ~13:05–13:25 window
    const requests = Math.round(between(rng, 340, 420) * hourFactor * (incident ? 1.9 : 1));
    const baseErr = between(rng, 0.004, 0.012);
    const errors = Math.round(requests * (incident ? 0.14 : baseErr));
    points.push({
      t: hhmm(t),
      requests,
      errors,
      p50: Math.round(between(rng, 380, 520) * (incident ? 2.1 : 1)),
      p95: Math.round(between(rng, 2200, 3400) * (incident ? 2.8 : 1)),
      tokens: Math.round(between(rng, 210_000, 320_000) * hourFactor * (incident ? 1.6 : 1)),
      costUsd: +between(rng, 3.1, 4.8).toFixed(2),
    });
  }
  return points;
}

export const topFailing = [
  { name: "POST /v1/tickets/bulk", layer: "api", errors: 41, rate: "12.4%" },
  { name: "classify_intent", layer: "llm", errors: 38, rate: "8.1%" },
  { name: "POST /v1/tickets/{id}/reply", layer: "api", errors: 17, rate: "2.2%" },
  { name: "search_kb", layer: "tool", errors: 11, rate: "1.9%" },
  { name: "draft_reply", layer: "llm", errors: 9, rate: "1.4%" },
] as const;

export const statCards = [
  { label: "requests · 6h", value: "9,847", delta: "+12%", good: true },
  { label: "error rate", value: "2.1%", delta: "+1.3pt", good: false },
  { label: "p95 latency", value: "3.2s", delta: "+40%", good: false },
  { label: "LLM cost · today", value: "$81.40", delta: "+6%", good: true },
] as const;
