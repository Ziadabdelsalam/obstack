/** Incident reconstruction: the 13:05 rate-limit cascade, stitched end to end. */

export type TimelineKind = "pipeline" | "k8s" | "alert" | "trace" | "metric" | "action" | "resolved";

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  link?: { label: string; href: string };
}

export interface Incident {
  id: string;
  title: string;
  status: "resolved" | "ongoing";
  started: string;
  ended: string;
  duration: string;
  severity: "critical" | "warning";
  impact: string;
  summary: string;
  timeline: TimelineEntry[];
}

export const incidents: Incident[] = [
  {
    id: "INC-42",
    title: "Provider rate-limit cascade during zendesk-migration import",
    status: "resolved",
    started: "13:04",
    ended: "13:26",
    duration: "22m",
    severity: "critical",
    impact: "41 requests failed with 504 on POST /v1/tickets/bulk · 3 customers affected · $0 revenue impact",
    summary:
      "A one-off batch import tripled request volume, tripping the LLM provider's rate limit. Aggressive retries (5× exponential backoff, Retry-After ignored) consumed gateway deadlines and saturated worker concurrency, amplifying the failure until import volume subsided.",
    timeline: [
      {
        at: "13:04:52",
        kind: "pipeline",
        title: "zendesk-migration backfill starts",
        detail: "1,800 tickets queued — request volume climbs to 3× baseline within 60s",
        link: { label: "pipeline", href: "/app/pipelines" },
      },
      {
        at: "13:05:02",
        kind: "trace",
        title: "First 429s from the LLM provider on classify_intent",
        detail: "Retries begin: 0.5s → 1s → 2s → 4s backoff, Retry-After header ignored",
        link: { label: "example trace", href: "/app/traces/c9d4e71f3a2b8c56" },
      },
      {
        at: "13:05:41",
        kind: "alert",
        title: "ALERT · Token spend spike: +212% vs baseline",
        detail: "#llm-costs notified",
        link: { label: "alert", href: "/app/alerts" },
      },
      {
        at: "13:06:10",
        kind: "alert",
        title: "ALERT · Error rate 14.2% on POST /v1/tickets/bulk",
        detail: "#incidents notified — paged on-call",
        link: { label: "alert", href: "/app/alerts" },
      },
      {
        at: "13:08:33",
        kind: "metric",
        title: "Worker queue depth peaks at 214 (normal <10)",
        detail: "84% of in-flight requests are retries — the failure is self-amplifying",
        link: { label: "queue logs", href: "/app/logs?q=queue" },
      },
      {
        at: "13:22:41",
        kind: "k8s",
        title: "agent-worker-7d9fb-kx2rq OOMKilled (restart #3)",
        detail: "Memory pressure from queued streaming buffers — 1 request failed with 502",
        link: { label: "OOM trace", href: "/app/traces/a3f8c1d92b6e407f" },
      },
      {
        at: "13:24:05",
        kind: "action",
        title: "Import throttled to 50 tickets/min by operator",
        detail: "Request volume returns under provider limit",
      },
      {
        at: "13:25:48",
        kind: "metric",
        title: "Error rate back under 1% · queue depth 8",
      },
      {
        at: "13:26:00",
        kind: "resolved",
        title: "Incident resolved",
        detail: "Follow-ups: cap retries on 429 (respect Retry-After) · rate-limit batch imports separately · raise agent-worker memory limit",
      },
    ],
  },
];
