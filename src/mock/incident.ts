/** Incident reconstruction: the 13:05 rate-limit cascade, stitched end to end. */

export type TimelineKind = "pipeline" | "k8s" | "alert" | "trace" | "metric" | "action" | "resolved";

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  title: string;
  detail?: string;
  link?: { label: string; href: string };
}

export interface RcaSection {
  heading: string;
  body: string;
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
  rca: RcaSection[];
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
    rca: [
      {
        heading: "Root cause",
        body: "An unbounded retry policy against provider 429s. classify_intent retried up to 5× with exponential backoff and ignored the Retry-After header, so every rate-limited request multiplied load on a provider that had already said no. The rate limit itself was ordinary; the retry policy turned it into an outage.",
      },
      {
        heading: "Trigger",
        body: "The zendesk-migration backfill started at 13:04:52 and pushed request volume to 3× baseline within 60 seconds, crossing the provider's account-level rate limit at 13:05:02.",
      },
      {
        heading: "Amplifiers",
        body: "Three factors turned a throttle into a cascade: (1) retries ignored Retry-After (21s) and re-hit the limit on a 0.5–4s schedule; (2) batch and interactive traffic share one worker concurrency pool, so retrying imports starved live requests — queue depth peaked at 214 with 84% retries; (3) queued streaming buffers pinned memory on agent-worker-7d9fb-kx2rq until the kubelet OOM-killed it at 13:22:41, adding a 502 to the 504s.",
      },
      {
        heading: "Detection",
        body: "Time to detect: 49 seconds. The token-spend anomaly alert fired at 13:05:41, before the error-rate page at 13:06:10 — cost was the earliest signal, ahead of errors. Time to mitigate: 19 minutes (operator throttled the import to 50 tickets/min at 13:24:05).",
      },
      {
        heading: "Blast radius",
        body: "41 requests failed with 504 on POST /v1/tickets/bulk and 1 with 502; 3 customers affected, all batch-import traffic — no interactive customer conversations were dropped. $0 direct revenue impact.",
      },
      {
        heading: "Action items",
        body: "1. Cap retries on 429 at 2 and respect Retry-After — owner: omar. 2. Separate rate limits and worker pools for batch vs interactive traffic — owner: nour. 3. Raise agent-worker memory 512Mi → 1Gi and stream to disk — owner: ziad. 4. Alert on queue depth > 50 (would have fired 13:06, caught amplification early) — owner: nour.",
      },
    ],
  },
];
