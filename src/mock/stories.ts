import type { Explanation, LogRecord, Span, Trace } from "./types";

/**
 * The three scripted failure stories. These are the demo's proof of the wedge:
 * cause in one layer, symptom in another, joined on one screen.
 */

const NS = "loopwork-prod";

/** default pod/node attribution per service (overridable per span) */
const POD_BY_SERVICE: Record<string, { pod: string; node: string }> = {
  gateway: { pod: "gateway-84c5f-jw6th", node: "gke-prod-pool1-a3f2" },
  "agent-worker": { pod: "agent-worker-7d9fb-kx2rq", node: "gke-prod-pool2-b7c9" },
  tools: { pod: "tools-6b6f4-w9qp2", node: "gke-prod-pool1-a3f2" },
  kafka: { pod: "kafka-broker-2", node: "gke-prod-pool3-d4e8" },
  notifier: { pod: "notifier-6d98c-v7slj", node: "gke-prod-pool1-f21a" },
};

function span(
  traceId: string,
  s: Omit<Span, "traceId" | "attrs"> & { attrs?: Span["attrs"] },
): Span {
  const res = POD_BY_SERVICE[s.service];
  return { attrs: {}, pod: res?.pod, node: res?.node, ...s, traceId };
}

function log(
  l: Omit<LogRecord, "namespace" | "container"> & {
    namespace?: string;
    container?: string;
  },
): LogRecord {
  return { namespace: NS, container: "app", ...l };
}

/* ------------------------------------------------------------------ */
/* Story 1 — OOM-killed pod truncates an LLM completion                */
/* ------------------------------------------------------------------ */

const OOM_ID = "a3f8c1d92b6e407f";
const OOM_POD = "agent-worker-7d9fb-kx2rq";

const oomExplanation: Explanation = {
  headline: "Pod OOM-kill truncated the draft_reply completion mid-stream",
  failedWhere:
    "Infra layer (pod agent-worker-7d9fb-kx2rq), surfacing as an LLM error in agent step draft_reply and a 502 at the API edge.",
  rootCause:
    "The agent-worker pod exceeded its 512Mi memory limit while streaming a long completion. The kubelet OOM-killed the container at +4.21s, dropping the stream. The SDK recorded finish_reason=truncated, the agent had no retry budget left, and the gateway returned 502 to the caller.",
  evidence: [
    {
      label: "logs · kubelet",
      detail: `OOMKilled: container "app" in pod ${OOM_POD} exceeded memory limit (512Mi)`,
    },
    {
      label: "span · draft_reply",
      detail: "finish_reason=truncated after 1,204 of ~1,900 expected output tokens",
    },
    {
      label: "logs · app",
      detail: "rss 498MiB and climbing in the 3s before the kill — matches stream buffering",
    },
    {
      label: "span · POST /v1/tickets/{id}/reply",
      detail: "502 returned at +4.94s, immediately after the agent step failed",
    },
  ],
  suggestion:
    "Raise the agent-worker memory limit (512Mi → 1Gi) or stream completions to disk instead of buffering. Consider a restart-aware retry so a single OOM doesn't surface to the customer.",
};

const oomSpans: Span[] = [
  span(OOM_ID, {
    id: "s-oom-root",
    parentId: null,
    name: "POST /v1/tickets/{id}/reply",
    layer: "api",
    service: "gateway",
    startMs: 0,
    durationMs: 4940,
    status: "error",
    statusMessage: "502 Bad Gateway",
    attrs: {
      "http.method": "POST",
      "http.route": "/v1/tickets/{id}/reply",
      "http.status_code": 502,
      "user.plan": "scale",
      "ticket.id": "TK-58213",
    },
  }),
  span(OOM_ID, {
    id: "s-oom-auth",
    parentId: "s-oom-root",
    name: "auth.verify + pg.query tickets",
    layer: "tool",
    service: "gateway",
    startMs: 4,
    durationMs: 26,
    status: "ok",
    attrs: { "db.system": "postgresql", "db.rows": 1, "auth.method": "api_key" },
  }),
  span(OOM_ID, {
    id: "s-oom-agent",
    parentId: "s-oom-root",
    name: "support-agent.run",
    layer: "agent",
    service: "agent-worker",
    startMs: 38,
    durationMs: 4860,
    status: "error",
    statusMessage: "step draft_reply failed: completion truncated",
    attrs: { "obstack.agent.name": "support-agent", "obstack.agent.steps": 4 },
  }),
  span(OOM_ID, {
    id: "s-oom-classify",
    parentId: "s-oom-agent",
    name: "classify_intent",
    layer: "llm",
    service: "agent-worker",
    startMs: 61,
    durationMs: 402,
    status: "ok",
    attrs: { "obstack.agent.step": "classify_intent" },
    llm: {
      model: "claude-haiku-4-5",
      inputTokens: 486,
      outputTokens: 12,
      costUsd: 0.0006,
      prompt:
        "Classify the intent of this support ticket. Respond with one of: billing, bug_report, feature_request, account, refund, other.\n\nTicket TK-58213 (customer: Meridian Labs, plan: Scale):\n\"Hi — our invoice for July shows 2.4M events but our dashboard says we sent 1.1M. Can you explain the difference? We need this resolved before our finance close on Friday.\"",
      completion: "billing",
      finishReason: "stop",
    },
  }),
  span(OOM_ID, {
    id: "s-oom-kb",
    parentId: "s-oom-agent",
    name: "search_kb",
    layer: "tool",
    service: "tools",
    startMs: 492,
    durationMs: 311,
    status: "ok",
    attrs: {
      "obstack.tool.name": "search_kb",
      "obstack.tool.query": "invoice event count mismatch dashboard",
      "obstack.tool.results": 4,
    },
  }),
  span(OOM_ID, {
    id: "s-oom-customer",
    parentId: "s-oom-agent",
    name: "fetch_customer",
    layer: "tool",
    service: "tools",
    startMs: 509,
    durationMs: 187,
    status: "ok",
    attrs: { "obstack.tool.name": "fetch_customer", "customer.id": "cus_9f2e1" },
  }),
  span(OOM_ID, {
    id: "s-oom-draft",
    parentId: "s-oom-agent",
    name: "draft_reply",
    layer: "llm",
    service: "agent-worker",
    startMs: 828,
    durationMs: 3390,
    status: "error",
    statusMessage: "stream aborted: connection reset (finish_reason=truncated)",
    attrs: { "obstack.agent.step": "draft_reply" },
    llm: {
      model: "claude-sonnet-5",
      inputTokens: 2841,
      outputTokens: 1204,
      costUsd: 0.0264,
      prompt:
        "You are Loopwork's support agent. Draft a reply to ticket TK-58213 using the retrieved context.\n\nContext:\n- KB: \"Billed events include spans AND log records; the dashboard 'events' chart shows spans only\" (article #142)\n- KB: \"Event counts are computed at ingest, before sampling\" (article #98)\n- Customer: Meridian Labs, Scale plan, 14 seats, contract renewal Oct 1\n\nTicket:\n\"Hi — our invoice for July shows 2.4M events but our dashboard says we sent 1.1M...\"",
      completion:
        "Hi there,\n\nThanks for flagging this — the difference comes down to what each number counts.\n\nYour invoice counts billable events, which include both spans and log records (2.4M total for July). The dashboard chart you're looking at shows spans only (1.1M), which is why the two disagree.\n\nTo see the full breakdown:\n1. Open Usage → July\n2. Toggle \"include log records\"\n3. You'll see 1.1M spans + 1.3M log recor—",
      finishReason: "truncated",
    },
  }),
];

const oomLogs: LogRecord[] = [
  log({
    id: "l-oom-1",
    traceId: OOM_ID,
    atMs: 851,
    severity: "info",
    body: "draft_reply: streaming completion started (model=claude-sonnet-5)",
    pod: OOM_POD,
  }),
  log({
    id: "l-oom-2",
    atMs: 1400,
    severity: "warn",
    body: "memory pressure: rss 447MiB / limit 512Mi",
    pod: OOM_POD,
  }),
  log({
    id: "l-oom-3",
    atMs: 3100,
    severity: "warn",
    body: "memory pressure: rss 498MiB / limit 512Mi",
    pod: OOM_POD,
  }),
  log({
    id: "l-oom-4",
    atMs: 4210,
    severity: "fatal",
    body: `OOMKilled: container "app" in pod ${OOM_POD} exceeded memory limit (512Mi)`,
    pod: OOM_POD,
    container: "kubelet",
  }),
  log({
    id: "l-oom-5",
    traceId: OOM_ID,
    atMs: 4230,
    severity: "error",
    body: "draft_reply: stream aborted — connection reset by peer",
    pod: OOM_POD,
  }),
  log({
    id: "l-oom-6",
    traceId: OOM_ID,
    atMs: 4900,
    severity: "error",
    body: "support-agent.run failed: no retry budget remaining (max_retries=0 for streaming steps)",
    pod: OOM_POD,
  }),
  log({
    id: "l-oom-7",
    atMs: 5600,
    severity: "info",
    body: `Back-off restarting container "app" in pod ${OOM_POD} (restart #3 in 1h)`,
    pod: OOM_POD,
    container: "kubelet",
  }),
];

export const oomTrace: Trace = {
  id: OOM_ID,
  rootName: "POST /v1/tickets/{id}/reply",
  method: "POST",
  service: "gateway",
  startedAt: "2026-08-09T13:22:41.000Z",
  durationMs: 4940,
  status: "error",
  spanCount: oomSpans.length,
  totalTokens: 4543,
  costUsd: 0.027,
  services: ["gateway", "agent-worker", "tools"],
  models: ["claude-haiku-4-5", "claude-sonnet-5"],
  spans: oomSpans,
  logs: oomLogs,
  k8sEvents: [
    {
      id: "e-oom-1",
      atMs: 4210,
      pod: OOM_POD,
      kind: "oom_kill",
      severity: "fatal",
      label: "OOMKilled — memory limit 512Mi exceeded",
    },
    {
      id: "e-oom-2",
      atMs: 5600,
      pod: OOM_POD,
      kind: "restart",
      severity: "warn",
      label: "Back-off restart #3 in 1h",
    },
  ],
  explanation: oomExplanation,
};

/* ------------------------------------------------------------------ */
/* Story 2 — Tool timeout retry chain makes a "successful" request slow */
/* ------------------------------------------------------------------ */

const SLOW_ID = "b7e2d94a1c8f5e30";
const SLOW_POD = "agent-worker-7d9fb-m8xzt";

const slowExplanation: Explanation = {
  headline: "search_kb timed out 3× — the reply succeeded, but without KB context",
  failedWhere:
    "Tool layer (search_kb → kb-service), degrading agent quality and stretching a 2s request to 16.4s.",
  rootCause:
    "kb-service was reindexing (visible in its pod logs), so search_kb hit its 5s timeout three times. The agent then took its fallback path and drafted a reply without KB context. The request returned 200, but the reply is generic and the review step scored it low-confidence.",
  evidence: [
    {
      label: "spans · search_kb ×3",
      detail: "three consecutive 5,000ms timeouts (attempt=1,2,3), then fallback",
    },
    {
      label: "logs · kb-service",
      detail: "\"reindex in progress — queries queued\" during the exact window",
    },
    {
      label: "span · review_reply",
      detail: "confidence=0.41 (threshold 0.7) — flagged low_context",
    },
  ],
  suggestion:
    "Fail fast when kb-service reports reindexing (health endpoint exists), cut timeout to 1.5s with jittered retry, and alert on review confidence below threshold — a 200 isn't always a success.",
};

function kbAttempt(n: number, startMs: number): Span {
  return span(SLOW_ID, {
    id: `s-slow-kb${n}`,
    parentId: "s-slow-agent",
    name: "search_kb",
    layer: "tool",
    service: "tools",
    startMs,
    durationMs: 5000,
    status: "error",
    statusMessage: `timeout after 5000ms (attempt ${n}/3)`,
    attrs: {
      "obstack.tool.name": "search_kb",
      "obstack.tool.attempt": n,
      "obstack.tool.query": "sso saml okta setup",
    },
  });
}

const slowSpans: Span[] = [
  span(SLOW_ID, {
    id: "s-slow-root",
    parentId: null,
    name: "POST /v1/chat",
    layer: "api",
    service: "gateway",
    startMs: 0,
    durationMs: 16420,
    status: "ok",
    attrs: {
      "http.method": "POST",
      "http.route": "/v1/chat",
      "http.status_code": 200,
      "session.id": "sess_h3k2m",
    },
  }),
  span(SLOW_ID, {
    id: "s-slow-agent",
    parentId: "s-slow-root",
    name: "support-agent.run",
    layer: "agent",
    service: "agent-worker",
    pod: SLOW_POD,
    startMs: 31,
    durationMs: 16350,
    status: "ok",
    statusMessage: "completed via fallback path (no KB context)",
    attrs: { "obstack.agent.name": "support-agent", "obstack.agent.steps": 6 },
  }),
  span(SLOW_ID, {
    id: "s-slow-classify",
    parentId: "s-slow-agent",
    name: "classify_intent",
    layer: "llm",
    service: "agent-worker",
    pod: SLOW_POD,
    startMs: 52,
    durationMs: 380,
    status: "ok",
    attrs: { "obstack.agent.step": "classify_intent" },
    llm: {
      model: "claude-haiku-4-5",
      inputTokens: 312,
      outputTokens: 9,
      costUsd: 0.0004,
      prompt:
        'Classify the intent: "How do I set up SSO with Okta? We\'re on the Scale plan."',
      completion: "account",
      finishReason: "stop",
    },
  }),
  kbAttempt(1, 448),
  kbAttempt(2, 5470),
  kbAttempt(3, 10490),
  span(SLOW_ID, {
    id: "s-slow-draft",
    parentId: "s-slow-agent",
    name: "draft_reply (fallback: no KB context)",
    layer: "llm",
    service: "agent-worker",
    pod: SLOW_POD,
    startMs: 15510,
    durationMs: 640,
    status: "ok",
    attrs: { "obstack.agent.step": "draft_reply", "obstack.agent.fallback": "no_kb_context" },
    llm: {
      model: "claude-sonnet-5",
      inputTokens: 702,
      outputTokens: 188,
      costUsd: 0.0049,
      prompt:
        "Draft a reply about Okta SSO setup. NOTE: knowledge base unavailable — answer from general knowledge only, be honest about limitations.",
      completion:
        "Hi! Loopwork supports SAML SSO on the Scale plan. In general you'll add Loopwork as a SAML app in Okta, then paste the metadata URL into Loopwork's SSO settings. I don't have our exact setup guide in front of me right now — I'm connecting you with the docs link and can walk you through any step that's unclear.",
      finishReason: "stop",
    },
  }),
  span(SLOW_ID, {
    id: "s-slow-review",
    parentId: "s-slow-agent",
    name: "review_reply",
    layer: "llm",
    service: "agent-worker",
    pod: SLOW_POD,
    startMs: 16160,
    durationMs: 210,
    status: "ok",
    statusMessage: "confidence 0.41 < 0.70 — flagged low_context",
    attrs: { "obstack.agent.step": "review_reply", "review.confidence": 0.41 },
    llm: {
      model: "claude-haiku-4-5",
      inputTokens: 401,
      outputTokens: 31,
      costUsd: 0.0007,
      prompt:
        "Score this draft reply for accuracy and completeness given the customer question. Return JSON {confidence, flags[]}.",
      completion: '{"confidence": 0.41, "flags": ["low_context", "no_source_citation"]}',
      finishReason: "stop",
    },
  }),
];

const slowLogs: LogRecord[] = [
  log({
    id: "l-slow-1",
    atMs: -2200,
    severity: "info",
    body: "reindex started: 48,211 documents (est. 90s)",
    pod: "kb-service-5c66d-qp4wn",
  }),
  log({
    id: "l-slow-2",
    atMs: 450,
    severity: "warn",
    body: "reindex in progress — queries queued (depth=17)",
    pod: "kb-service-5c66d-qp4wn",
  }),
  log({
    id: "l-slow-3",
    traceId: SLOW_ID,
    atMs: 5450,
    severity: "warn",
    body: "search_kb attempt 1 timed out after 5000ms — retrying",
    pod: SLOW_POD,
  }),
  log({
    id: "l-slow-4",
    traceId: SLOW_ID,
    atMs: 10470,
    severity: "warn",
    body: "search_kb attempt 2 timed out after 5000ms — retrying",
    pod: SLOW_POD,
  }),
  log({
    id: "l-slow-5",
    traceId: SLOW_ID,
    atMs: 15490,
    severity: "error",
    body: "search_kb attempt 3 timed out — taking fallback path no_kb_context",
    pod: SLOW_POD,
  }),
  log({
    id: "l-slow-6",
    traceId: SLOW_ID,
    atMs: 16380,
    severity: "warn",
    body: "review_reply: confidence 0.41 below threshold 0.70 (flags: low_context)",
    pod: SLOW_POD,
  }),
];

export const slowTrace: Trace = {
  id: SLOW_ID,
  rootName: "POST /v1/chat",
  method: "POST",
  service: "gateway",
  startedAt: "2026-08-09T12:57:03.000Z",
  durationMs: 16420,
  status: "ok",
  spanCount: slowSpans.length,
  totalTokens: 1643,
  costUsd: 0.006,
  services: ["gateway", "agent-worker", "tools"],
  models: ["claude-haiku-4-5", "claude-sonnet-5"],
  spans: slowSpans,
  logs: slowLogs,
  k8sEvents: [
    {
      id: "e-slow-1",
      atMs: -2200,
      pod: "kb-service-5c66d-qp4wn",
      kind: "reindex",
      severity: "warn",
      label: "Reindex started — 48,211 documents, queries queued",
    },
  ],
  explanation: slowExplanation,
};

/* ------------------------------------------------------------------ */
/* Story 3 — Provider rate-limit cascade                               */
/* ------------------------------------------------------------------ */

const RATE_ID = "c9d4e71f3a2b8c56";
const RATE_POD = "agent-worker-7d9fb-kx2rq";

const rateExplanation: Explanation = {
  headline: "Provider 429s cascaded: retries ate the deadline, the queue backed up",
  failedWhere:
    "LLM layer (provider rate limit on classify_intent), amplified by aggressive retries in the agent layer, surfacing as a 504 at the API edge.",
  rootCause:
    "The LLM provider returned 429 (rate_limit_exceeded) at 13:05, when a batch import tripled request volume. classify_intent retried 4× with exponential backoff (0.5s→4s), consuming 9.2s of the 10s gateway deadline. Worker concurrency was saturated by retrying requests — queue depth hit 214 — so the failure self-amplified.",
  evidence: [
    {
      label: "spans · classify_intent ×5",
      detail: "attempts 1–5 all returned 429; backoff 0.5s, 1s, 2s, 4s between them",
    },
    {
      label: "logs · app",
      detail: "queue depth 214 (normal <10) during the incident window",
    },
    {
      label: "logs · batch-import",
      detail: "import job started 13:04:52 — 3× normal request volume",
    },
    {
      label: "span · root",
      detail: "504 deadline exceeded at exactly 10,000ms",
    },
  ],
  suggestion:
    "Cap retries against 429s (2 max) and respect Retry-After. Rate-limit the batch importer separately from interactive traffic, and shed load at the queue instead of retrying into saturation.",
};

function rateAttempt(n: number, startMs: number, backoffNote: string): Span {
  return span(RATE_ID, {
    id: `s-rate-a${n}`,
    parentId: "s-rate-agent",
    name: "classify_intent",
    layer: "llm",
    service: "agent-worker",
    startMs,
    durationMs: 180 + n * 12,
    status: "error",
    statusMessage: `429 rate_limit_exceeded (attempt ${n}/5)${backoffNote}`,
    attrs: { "obstack.agent.step": "classify_intent", "retry.attempt": n },
    llm: {
      model: "claude-haiku-4-5",
      inputTokens: 366,
      outputTokens: 0,
      costUsd: 0,
      prompt:
        'Classify the intent: "Bulk update: closing 1,800 resolved tickets from our migration."',
      completion: "",
      finishReason: "error",
    },
  });
}

const rateSpans: Span[] = [
  span(RATE_ID, {
    id: "s-rate-root",
    parentId: null,
    name: "POST /v1/tickets/bulk",
    layer: "api",
    service: "gateway",
    startMs: 0,
    durationMs: 10000,
    status: "error",
    statusMessage: "504 deadline exceeded",
    attrs: {
      "http.method": "POST",
      "http.route": "/v1/tickets/bulk",
      "http.status_code": 504,
      "batch.size": 1800,
    },
  }),
  span(RATE_ID, {
    id: "s-rate-agent",
    parentId: "s-rate-root",
    name: "support-agent.run",
    layer: "agent",
    service: "agent-worker",
    startMs: 42,
    durationMs: 9950,
    status: "error",
    statusMessage: "deadline exceeded during retry backoff",
    attrs: { "obstack.agent.name": "support-agent", "queue.depth_at_start": 214 },
  }),
  rateAttempt(1, 60, " — backoff 500ms"),
  rateAttempt(2, 760, " — backoff 1s"),
  rateAttempt(3, 1980, " — backoff 2s"),
  rateAttempt(4, 4200, " — backoff 4s"),
  rateAttempt(5, 8420, ""),
];

const rateLogs: LogRecord[] = [
  log({
    id: "l-rate-0",
    atMs: -8000,
    severity: "info",
    body: "batch import job started: 1,800 tickets (source=zendesk-migration)",
    pod: "batch-import-6f8d2-tt5vk",
  }),
  log({
    id: "l-rate-1",
    atMs: -1200,
    severity: "warn",
    body: "queue depth 214 (normal <10) — worker concurrency saturated",
    pod: RATE_POD,
  }),
  log({
    id: "l-rate-2",
    traceId: RATE_ID,
    atMs: 250,
    severity: "warn",
    body: "provider 429 rate_limit_exceeded — retry 1/5 in 500ms",
    pod: RATE_POD,
  }),
  log({
    id: "l-rate-3",
    traceId: RATE_ID,
    atMs: 4400,
    severity: "warn",
    body: "provider 429 rate_limit_exceeded — retry 4/5 in 4000ms (Retry-After: 21s, ignored)",
    pod: RATE_POD,
  }),
  log({
    id: "l-rate-4",
    traceId: RATE_ID,
    atMs: 9990,
    severity: "error",
    body: "gateway deadline exceeded (10s) — request abandoned mid-backoff",
    pod: RATE_POD,
  }),
  log({
    id: "l-rate-5",
    atMs: 11000,
    severity: "warn",
    body: "queue depth 231 and rising — 84% of in-flight requests are retries",
    pod: RATE_POD,
  }),
];

export const rateTrace: Trace = {
  id: RATE_ID,
  rootName: "POST /v1/tickets/bulk",
  method: "POST",
  service: "gateway",
  startedAt: "2026-08-09T13:05:17.000Z",
  durationMs: 10000,
  status: "error",
  spanCount: rateSpans.length,
  totalTokens: 1830,
  costUsd: 0.0004,
  services: ["gateway", "agent-worker"],
  models: ["claude-haiku-4-5"],
  spans: rateSpans,
  logs: rateLogs,
  k8sEvents: [
    {
      id: "e-rate-1",
      atMs: -8000,
      pod: "batch-import-6f8d2-tt5vk",
      kind: "scale",
      severity: "info",
      label: "Job started: zendesk-migration (1,800 tickets)",
    },
    {
      id: "e-rate-2",
      atMs: -1200,
      pod: RATE_POD,
      kind: "throttle",
      severity: "warn",
      label: "Worker saturated — queue depth 214 (normal <10)",
    },
  ],
  explanation: rateExplanation,
};

/* ------------------------------------------------------------------ */
/* Story 4 — The full pipeline, end to end                             */
/* Trigger (webhook) → gateway → Kafka → agent → LLM → DB → notify.    */
/* The API root returns 202 in 58ms; the trace keeps going. One trace  */
/* context propagated through the queue joins the whole journey.       */
/* ------------------------------------------------------------------ */

const PIPE_ID = "d8a1f5c47e92b013";

const pipeSpans: Span[] = [
  span(PIPE_ID, {
    id: "s-pipe-root",
    parentId: null,
    name: "POST /v1/webhooks/zendesk",
    layer: "api",
    service: "gateway",
    startMs: 0,
    durationMs: 58,
    status: "ok",
    attrs: {
      "http.method": "POST",
      "http.route": "/v1/webhooks/zendesk",
      "http.status_code": 202,
      "webhook.event": "ticket.created",
      "ticket.id": "TK-58291",
    },
  }),
  span(PIPE_ID, {
    id: "s-pipe-verify",
    parentId: "s-pipe-root",
    name: "webhook.verify_signature",
    layer: "tool",
    service: "gateway",
    startMs: 2,
    durationMs: 5,
    status: "ok",
    attrs: { "webhook.source": "zendesk" },
  }),
  span(PIPE_ID, {
    id: "s-pipe-insert",
    parentId: "s-pipe-root",
    name: "pg.insert ticket_events",
    layer: "tool",
    service: "gateway",
    startMs: 9,
    durationMs: 17,
    status: "ok",
    attrs: { "db.system": "postgresql", "db.operation": "INSERT" },
  }),
  span(PIPE_ID, {
    id: "s-pipe-publish",
    parentId: "s-pipe-root",
    name: "kafka.publish ticket-events",
    layer: "tool",
    service: "gateway",
    startMs: 30,
    durationMs: 14,
    status: "ok",
    attrs: {
      "messaging.system": "kafka",
      "messaging.destination": "ticket-events",
      "messaging.partition": 3,
      "messaging.offset": 18422,
    },
  }),
  span(PIPE_ID, {
    id: "s-pipe-dwell",
    parentId: "s-pipe-publish",
    name: "queue dwell · ticket-events p3",
    layer: "infra",
    service: "kafka",
    startMs: 44,
    durationMs: 568,
    status: "ok",
    statusMessage: "568ms in queue (consumer lag: 12 messages)",
    attrs: { "messaging.system": "kafka", "messaging.partition": 3, "consumer.lag": 12 },
  }),
  span(PIPE_ID, {
    id: "s-pipe-consume",
    parentId: "s-pipe-dwell",
    name: "kafka.consume ticket-events",
    layer: "tool",
    service: "agent-worker",
    startMs: 612,
    durationMs: 28,
    status: "ok",
    attrs: { "messaging.system": "kafka", "messaging.consumer_group": "agent-workers" },
  }),
  span(PIPE_ID, {
    id: "s-pipe-agent",
    parentId: "s-pipe-consume",
    name: "support-agent.run",
    layer: "agent",
    service: "agent-worker",
    startMs: 650,
    durationMs: 2250,
    status: "ok",
    attrs: { "obstack.agent.name": "support-agent", "obstack.agent.steps": 6 },
  }),
  span(PIPE_ID, {
    id: "s-pipe-classify",
    parentId: "s-pipe-agent",
    name: "classify_intent",
    layer: "llm",
    service: "agent-worker",
    startMs: 660,
    durationMs: 370,
    status: "ok",
    attrs: { "obstack.agent.step": "classify_intent" },
    llm: {
      model: "claude-haiku-4-5",
      inputTokens: 412,
      outputTokens: 10,
      costUsd: 0.0005,
      prompt:
        'Classify the intent of this new ticket: "Our webhook deliveries to staging stopped after we rotated the signing secret. Docs unclear on propagation delay?"',
      completion: "bug_report",
      finishReason: "stop",
    },
  }),
  span(PIPE_ID, {
    id: "s-pipe-cust",
    parentId: "s-pipe-agent",
    name: "fetch_customer",
    layer: "tool",
    service: "tools",
    startMs: 1040,
    durationMs: 170,
    status: "ok",
    attrs: { "obstack.tool.name": "fetch_customer", "customer.id": "cus_2d81b" },
  }),
  span(PIPE_ID, {
    id: "s-pipe-kb",
    parentId: "s-pipe-agent",
    name: "search_kb",
    layer: "tool",
    service: "tools",
    startMs: 1048,
    durationMs: 322,
    status: "ok",
    attrs: {
      "obstack.tool.name": "search_kb",
      "obstack.tool.query": "webhook signing secret rotation propagation",
      "obstack.tool.results": 3,
    },
  }),
  span(PIPE_ID, {
    id: "s-pipe-draft",
    parentId: "s-pipe-agent",
    name: "draft_reply",
    layer: "llm",
    service: "agent-worker",
    startMs: 1390,
    durationMs: 1120,
    status: "ok",
    attrs: { "obstack.agent.step": "draft_reply" },
    llm: {
      model: "claude-sonnet-5",
      inputTokens: 2214,
      outputTokens: 342,
      costUsd: 0.0118,
      prompt:
        "You are Loopwork's support agent. Draft a reply using the retrieved context.\n\nContext:\n- KB #77: \"Rotated signing secrets propagate within 60s; old secret stays valid for 24h\"\n- KB #78: \"Staging endpoints must re-verify after rotation\"\n- Customer: Nimbus Retail, Pro plan\n\nTicket: \"Our webhook deliveries to staging stopped after we rotated the signing secret...\"",
      completion:
        "Hi! After rotating a signing secret, the new secret propagates within about 60 seconds — but staging endpoints keep validating against the cached old secret until they re-verify. That's why staging went quiet while production kept working.\n\nTwo steps to fix it:\n1. In Settings → Webhooks → Staging, click \"Re-verify endpoint\"\n2. Redeliver the failed events from the same screen (they're retained for 72h)\n\nThe old secret stays valid for 24h as a safety window, so no deliveries were lost.",
      finishReason: "stop",
    },
  }),
  span(PIPE_ID, {
    id: "s-pipe-review",
    parentId: "s-pipe-agent",
    name: "review_reply",
    layer: "llm",
    service: "agent-worker",
    startMs: 2520,
    durationMs: 230,
    status: "ok",
    attrs: { "obstack.agent.step": "review_reply", "review.confidence": 0.93 },
    llm: {
      model: "claude-haiku-4-5",
      inputTokens: 486,
      outputTokens: 28,
      costUsd: 0.0006,
      prompt: "Score this draft reply for accuracy and completeness. Return JSON {confidence, flags[]}.",
      completion: '{"confidence": 0.93, "flags": []}',
      finishReason: "stop",
    },
  }),
  span(PIPE_ID, {
    id: "s-pipe-update",
    parentId: "s-pipe-agent",
    name: "pg.update tickets (status=replied)",
    layer: "tool",
    service: "agent-worker",
    startMs: 2770,
    durationMs: 88,
    status: "ok",
    attrs: { "db.system": "postgresql", "db.operation": "UPDATE", "ticket.status": "replied" },
  }),
  span(PIPE_ID, {
    id: "s-pipe-email",
    parentId: "s-pipe-agent",
    name: "email.send reply (sendgrid)",
    layer: "tool",
    service: "notifier",
    startMs: 2905,
    durationMs: 325,
    status: "ok",
    attrs: { "email.provider": "sendgrid", "email.template": "ticket-reply" },
  }),
  span(PIPE_ID, {
    id: "s-pipe-ws",
    parentId: "s-pipe-agent",
    name: "ws.push ticket.updated",
    layer: "tool",
    service: "notifier",
    startMs: 2910,
    durationMs: 42,
    status: "ok",
    attrs: { "ws.channel": "workspace:nimbus-retail", "ws.clients": 4 },
  }),
];

const pipeLogs: LogRecord[] = [
  log({
    id: "l-pipe-1",
    traceId: PIPE_ID,
    atMs: 3,
    severity: "info",
    body: "webhook received: zendesk ticket.created (TK-58291)",
    pod: "gateway-84c5f-jw6th",
  }),
  log({
    id: "l-pipe-2",
    traceId: PIPE_ID,
    atMs: 50,
    severity: "info",
    body: "202 returned — pipeline continues async via ticket-events",
    pod: "gateway-84c5f-jw6th",
  }),
  log({
    id: "l-pipe-3",
    traceId: PIPE_ID,
    atMs: 615,
    severity: "info",
    body: "consumed offset 18422 from ticket-events p3 (dwell 568ms, lag 12)",
    pod: "agent-worker-7d9fb-kx2rq",
  }),
  log({
    id: "l-pipe-4",
    traceId: PIPE_ID,
    atMs: 2515,
    severity: "info",
    body: "draft_reply complete: 342 tokens, confidence pending review",
    pod: "agent-worker-7d9fb-kx2rq",
  }),
  log({
    id: "l-pipe-5",
    traceId: PIPE_ID,
    atMs: 3230,
    severity: "info",
    body: "reply delivered: email sent + 4 clients notified — TK-58291 replied in 3.23s end-to-end",
    pod: "notifier-6d98c-v7slj",
  }),
];

export const pipelineTrace: Trace = {
  id: PIPE_ID,
  rootName: "POST /v1/webhooks/zendesk",
  method: "POST",
  service: "gateway",
  startedAt: "2026-08-09T13:31:02.000Z",
  durationMs: 3230,
  status: "ok",
  spanCount: pipeSpans.length,
  totalTokens: 3492,
  costUsd: 0.0129,
  services: ["gateway", "kafka", "agent-worker", "tools", "notifier"],
  models: ["claude-haiku-4-5", "claude-sonnet-5"],
  spans: pipeSpans,
  logs: pipeLogs,
};

export const storyTraces: Trace[] = [oomTrace, slowTrace, rateTrace, pipelineTrace];
