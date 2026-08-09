/** Mock data for the intelligence layer: alerts, ask, evals. */

export interface AlertRule {
  name: string;
  condition: string;
  channel: string;
  enabled: boolean;
  lastTriggered: string;
}

export const alertRules: AlertRule[] = [
  {
    name: "Error rate",
    condition: "error_rate > 5% over 10m · any route",
    channel: "#incidents (Slack)",
    enabled: true,
    lastTriggered: "34m ago",
  },
  {
    name: "p95 latency",
    condition: "p95 > 8s over 10m · POST routes",
    channel: "#incidents (Slack)",
    enabled: true,
    lastTriggered: "36m ago",
  },
  {
    name: "Pod crash loop",
    condition: "restarts >= 3 within 1h · any pod",
    channel: "#incidents (Slack)",
    enabled: true,
    lastTriggered: "17m ago",
  },
  {
    name: "Consumer lag",
    condition: "kafka lag > 500 over 5m · ticket-events",
    channel: "#incidents (Slack)",
    enabled: true,
    lastTriggered: "never",
  },
  {
    name: "Token spend spike",
    condition: "token_spend > 2× 7-day baseline over 15m",
    channel: "#llm-costs (Slack)",
    enabled: true,
    lastTriggered: "35m ago",
  },
  {
    name: "Agent loop detection",
    condition: "agent_steps > 12 · any support-agent run",
    channel: "#incidents (Slack)",
    enabled: true,
    lastTriggered: "3d ago",
  },
  {
    name: "Tool failure cluster",
    condition: "tool_errors >= 10 within 5m · same tool",
    channel: "email · oncall@loopwork.ai",
    enabled: true,
    lastTriggered: "42m ago",
  },
  {
    name: "Review confidence drop",
    condition: "avg(review.confidence) < 0.75 over 1h",
    channel: "#agent-quality (Slack)",
    enabled: true,
    lastTriggered: "yesterday",
  },
];

export interface AlertEvent {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string;
  time: string;
  link: string;
}

export const alertEvents: AlertEvent[] = [
  {
    severity: "critical",
    title: "Error rate 14.2% on POST /v1/tickets/bulk",
    detail:
      "Provider 429 cascade during zendesk-migration batch import. 41 failed requests in 20m; retries saturated worker queue (depth 214).",
    time: "13:06 · 34m ago",
    link: "/app/traces/c9d4e71f3a2b8c56",
  },
  {
    severity: "warning",
    title: "Token spend spike: +212% vs baseline",
    detail: "Driven by batch import re-classifications. Projected +$14.80/day if sustained.",
    time: "13:05 · 35m ago",
    link: "/app/traces?q=bulk",
  },
  {
    severity: "warning",
    title: "Tool failure cluster: search_kb — 11 timeouts in 5m",
    detail: "kb-service reindex window. Agent fallback engaged on 9 runs; avg review confidence dropped to 0.52 during window.",
    time: "12:58 · 42m ago",
    link: "/app/traces/b7e2d94a1c8f5e30",
  },
  {
    severity: "info",
    title: "Pod restarted: agent-worker-7d9fb-kx2rq (restart #3 in 1h)",
    detail: "OOMKilled at 512Mi limit while streaming a completion. 1 request failed with 502.",
    time: "13:22 · 17m ago",
    link: "/app/traces/a3f8c1d92b6e407f",
  },
];

export interface AskExchange {
  question: string;
  answer: string;
  evidence: { label: string; href: string }[];
}

export const askSuggestions = [
  "Why did error rate spike at 13:05?",
  "What's driving LLM cost today?",
  "Which pods failed in the last hour?",
  "Why are some replies low quality since 12:55?",
];

export const askExchanges: AskExchange[] = [
  {
    question: "Why did error rate spike at 13:05?",
    answer:
      "The spike traces to a provider rate-limit cascade. At 13:04:52 the zendesk-migration batch import started and tripled request volume. The LLM provider began returning 429s on classify_intent; the agent retried up to 5× with exponential backoff, which consumed the 10s gateway deadline and saturated worker concurrency (queue depth hit 214, 84% of in-flight requests were retries). 41 requests on POST /v1/tickets/bulk failed with 504 before volume subsided at ~13:25.\n\nThe failure amplified itself: retries against a rate limit added load exactly when capacity was lowest. Two changes would prevent recurrence — cap retries on 429 (respect Retry-After), and rate-limit batch imports separately from interactive traffic.",
    evidence: [
      { label: "example failed trace · 504", href: "/app/traces/c9d4e71f3a2b8c56" },
      { label: "all bulk errors", href: "/app/traces?q=bulk&status=error" },
      { label: "dashboard · 13:05 window", href: "/app" },
    ],
  },
  {
    question: "Why are some replies low quality since 12:55?",
    answer:
      "Between 12:55 and 13:00, kb-service ran a full reindex (48,211 documents). During that window search_kb timed out on 11 agent runs; each fell back to drafting without knowledge-base context. Review confidence on those replies averaged 0.52 versus the 0.91 daily norm, and 9 replies were flagged low_context.\n\nThe replies still returned 200 — this is a silent quality degradation, not an error. Consider failing fast when kb-service reports reindexing (its health endpoint already exposes this) and alerting on review-confidence drops, which would have caught this 40 minutes earlier.",
    evidence: [
      { label: "example degraded trace · 16.4s", href: "/app/traces/b7e2d94a1c8f5e30" },
      { label: "slow agent runs", href: "/app/traces?minMs=5000" },
    ],
  },
];

export interface Deploy {
  sha: string;
  time: string;
  author: string;
  confidenceBefore: number;
  confidenceAfter: number;
  costPerReqBefore: number;
  costPerReqAfter: number;
  regression: boolean;
  note?: string;
}

export const deploys: Deploy[] = [
  {
    sha: "f4a2c91",
    time: "Aug 9, 11:40",
    author: "nour",
    confidenceBefore: 0.91,
    confidenceAfter: 0.92,
    costPerReqBefore: 0.021,
    costPerReqAfter: 0.019,
    regression: false,
    note: "prompt: tightened draft_reply system prompt",
  },
  {
    sha: "b81de07",
    time: "Aug 8, 14:12",
    author: "omar",
    confidenceBefore: 0.92,
    confidenceAfter: 0.78,
    costPerReqBefore: 0.019,
    costPerReqAfter: 0.024,
    regression: true,
    note: "swapped classify_intent to larger model + longer context",
  },
  {
    sha: "9cc41f2",
    time: "Aug 7, 09:55",
    author: "ziad",
    confidenceBefore: 0.9,
    confidenceAfter: 0.92,
    costPerReqBefore: 0.02,
    costPerReqAfter: 0.019,
    regression: false,
    note: "kb retrieval: rerank top-8 → top-4",
  },
];

export interface CostRec {
  title: string;
  detail: string;
  savings: string;
}

export const costRecs: CostRec[] = [
  {
    title: "Route classify_intent to claude-haiku-4-5 everywhere",
    detail:
      "8.1% of classify calls still hit claude-sonnet-5 via the bulk path. Confidence delta between models on this step is 0.00 across 4,120 sampled runs.",
    savings: "~$96/mo",
  },
  {
    title: "Trim draft_reply context: drop KB articles below relevance 0.4",
    detail:
      "31% of prompt tokens come from low-relevance KB articles that the reply never cites. Trimming them shows no confidence change on replayed traces.",
    savings: "~$210/mo",
  },
  {
    title: "Cache classify_intent for duplicate webhook deliveries",
    detail:
      "6.2% of ticket events are redelivered duplicates (same ticket.id + hash) re-classified from scratch.",
    savings: "~$41/mo",
  },
];
