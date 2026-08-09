/** Grouped recurring errors (fingerprinted), Sentry-style. */

import type { Layer } from "./types";

export interface Issue {
  fingerprint: string;
  title: string;
  layer: Layer;
  service: string;
  count7d: number;
  /** 14 buckets, oldest first — occurrence sparkline */
  spark: number[];
  firstSeen: string;
  lastSeen: string;
  status: "ongoing" | "resolved" | "new";
  exampleTraceId?: string;
  exampleLink?: string;
}

export const issues: Issue[] = [
  {
    fingerprint: "search_kb timeout after 5000ms",
    title: "search_kb: timeout after 5000ms",
    layer: "tool",
    service: "tools → kb-service",
    count7d: 47,
    spark: [2, 1, 0, 3, 2, 1, 2, 0, 1, 3, 2, 4, 11, 15],
    firstSeen: "Jun 14",
    lastSeen: "42m ago",
    status: "ongoing",
    exampleTraceId: "b7e2d94a1c8f5e30",
  },
  {
    fingerprint: "provider 429 rate_limit_exceeded",
    title: "LLM provider: 429 rate_limit_exceeded",
    layer: "llm",
    service: "agent-worker",
    count7d: 41,
    spark: [0, 0, 1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 2, 35],
    firstSeen: "Jul 2",
    lastSeen: "34m ago",
    status: "ongoing",
    exampleTraceId: "c9d4e71f3a2b8c56",
  },
  {
    fingerprint: "pg 40P01 deadlock_detected",
    title: "Postgres: deadlock_detected (40P01) on tickets batch update",
    layer: "tool",
    service: "sync-worker",
    count7d: 12,
    spark: [1, 0, 2, 1, 0, 1, 2, 1, 0, 1, 1, 0, 1, 1],
    firstSeen: "May 28",
    lastSeen: "2h ago",
    status: "ongoing",
    exampleLink: "/app/traces?q=deadlock",
  },
  {
    fingerprint: "OOMKilled agent-worker 512Mi",
    title: "OOMKilled: agent-worker exceeded 512Mi during streaming",
    layer: "infra",
    service: "agent-worker",
    count7d: 3,
    spark: [0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1],
    firstSeen: "Aug 3",
    lastSeen: "17m ago",
    status: "new",
    exampleTraceId: "a3f8c1d92b6e407f",
  },
  {
    fingerprint: "pg pool exhausted gateway",
    title: "Postgres: connection pool exhausted (20/20 in use)",
    layer: "api",
    service: "gateway",
    count7d: 6,
    spark: [0, 1, 0, 0, 2, 0, 0, 1, 0, 0, 1, 0, 1, 0],
    firstSeen: "Jul 19",
    lastSeen: "3h ago",
    status: "ongoing",
    exampleLink: "/app/traces?q=pool&status=error",
  },
  {
    fingerprint: "completion truncated finish_reason",
    title: "LLM completion truncated (finish_reason=truncated)",
    layer: "llm",
    service: "agent-worker",
    count7d: 4,
    spark: [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1],
    firstSeen: "Jul 30",
    lastSeen: "17m ago",
    status: "ongoing",
    exampleTraceId: "a3f8c1d92b6e407f",
  },
  {
    fingerprint: "webhook signature invalid zendesk",
    title: "Webhook: invalid signature from zendesk (stale secret)",
    layer: "api",
    service: "gateway",
    count7d: 0,
    spark: [4, 6, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    firstSeen: "Jun 2",
    lastSeen: "5d ago",
    status: "resolved",
    exampleLink: "/app/traces?q=webhook",
  },
];
