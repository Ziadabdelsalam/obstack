import { between, hexId, mulberry32, pick } from "./rand";
import type { K8sEvent, LogRecord, Span, Trace } from "./types";

/** Fixed anchor so SSR and client render identically. */
export const NOW = Date.parse("2026-08-09T13:40:00.000Z");

type Shape = "agent" | "plain" | "webhook" | "worker";

const ROUTES: { name: string; method: string; shape: Shape; weight: number }[] = [
  { name: "POST /v1/tickets/{id}/reply", method: "POST", shape: "agent", weight: 4 },
  { name: "POST /v1/chat", method: "POST", shape: "agent", weight: 5 },
  { name: "POST /v1/webhooks/zendesk", method: "POST", shape: "webhook", weight: 3 },
  { name: "GET /v1/tickets", method: "GET", shape: "plain", weight: 4 },
  { name: "GET /v1/tickets/{id}", method: "GET", shape: "plain", weight: 3 },
  { name: "POST /v1/tickets/bulk", method: "POST", shape: "agent", weight: 1 },
  { name: "job: sync-tickets", method: "JOB", shape: "worker", weight: 3 },
];

const NODES = ["gke-prod-pool1-a3f2", "gke-prod-pool2-b7c9", "gke-prod-pool1-f21a"];
const GATEWAY_PODS = ["gateway-84c5f-jw6th", "gateway-84c5f-r2d8m"];
const AGENT_PODS = [
  "agent-worker-7d9fb-kx2rq",
  "agent-worker-7d9fb-m8xzt",
  "agent-worker-7d9fb-p2vnc",
];
const TOOLS_POD = "tools-6b6f4-w9qp2";
const WORKER_POD = "sync-worker-59fd7-hh2kq";

const CHAT_PROMPTS = [
  {
    q: "Where do I find my API key?",
    a: "You can find your API key under Settings → API keys. Each workspace has its own key — rotate it any time and the old one stays valid for 24 hours.",
  },
  {
    q: "Can we export tickets to CSV?",
    a: "Yes — open the ticket list, apply any filters you want, then click Export → CSV in the top right. Exports include all visible columns plus ticket IDs.",
  },
  {
    q: "Why was my card charged twice this month?",
    a: "I can see two charges: one is your monthly subscription, the other is a usage overage from last cycle that bills separately. I've linked both invoices — if the overage looks wrong, I can open a billing review.",
  },
  {
    q: "How do I add a teammate?",
    a: "Go to Settings → Members → Invite. Teammates get editor access by default; you can change their role from the same screen once they accept.",
  },
];

function weightedRoute(rng: () => number) {
  const total = ROUTES.reduce((s, r) => s + r.weight, 0);
  let roll = rng() * total;
  for (const r of ROUTES) {
    roll -= r.weight;
    if (roll <= 0) return r;
  }
  return ROUTES[0];
}

function baseLog(
  id: string,
  traceId: string | undefined,
  atMs: number,
  severity: LogRecord["severity"],
  body: string,
  pod: string,
): LogRecord {
  return { id, traceId, atMs, severity, body, namespace: "loopwork-prod", pod, container: "app" };
}

function maybeInfraEvent(rng: () => number, id: string, pod: string): K8sEvent[] {
  if (rng() > 0.08) return [];
  const kinds = [
    { kind: "restart" as const, severity: "warn" as const, label: "Container restarted (liveness probe failed)" },
    { kind: "throttle" as const, severity: "warn" as const, label: "CPUThrottlingHigh — 71% of periods throttled" },
    { kind: "scale" as const, severity: "info" as const, label: "HPA scaled deployment 3 → 4 replicas" },
  ];
  const k = pick(rng, kinds);
  return [{ id: `${id}-k8s`, atMs: Math.round(between(rng, -3000, 1500)), pod, ...k }];
}

function makeAgentTrace(
  rng: () => number,
  id: string,
  route: (typeof ROUTES)[number],
  startedAt: number,
): Trace {
  const chat = pick(rng, CHAT_PROMPTS);
  const failed = rng() < 0.08;
  const gwPod = pick(rng, GATEWAY_PODS);
  const agPod = pick(rng, AGENT_PODS);

  const classifyMs = Math.round(between(rng, 280, 520));
  const kbMs = Math.round(between(rng, 150, 600));
  const custMs = Math.round(between(rng, 90, 260));
  const draftMs = Math.round(between(rng, 900, 2600));
  const reviewMs = Math.round(between(rng, 150, 320));
  const toolStart = 40 + classifyMs + 15;
  const draftStart = toolStart + Math.max(kbMs, custMs) + 20;
  const reviewStart = draftStart + draftMs + 12;
  const total = reviewStart + reviewMs + Math.round(between(rng, 20, 80));

  const inTok = Math.round(between(rng, 1400, 3200));
  const outTok = Math.round(between(rng, 200, 900));
  const cost = +(inTok * 0.000003 + outTok * 0.000015).toFixed(4);

  const spans: Span[] = [
    {
      id: `${id}-root`,
      traceId: id,
      parentId: null,
      name: route.name,
      layer: "api",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 0,
      durationMs: total,
      status: failed ? "error" : "ok",
      statusMessage: failed ? "500 Internal Server Error" : undefined,
      attrs: {
        "http.method": route.method,
        "http.route": route.name.split(" ")[1],
        "http.status_code": failed ? 500 : 200,
      },
    },
    {
      id: `${id}-auth`,
      traceId: id,
      parentId: `${id}-root`,
      name: "auth.verify + pg.query tickets",
      layer: "tool",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 4,
      durationMs: Math.round(between(rng, 12, 34)),
      status: "ok",
      attrs: { "db.system": "postgresql", "db.rows": 1, "auth.method": "api_key" },
    },
    {
      id: `${id}-agent`,
      traceId: id,
      parentId: `${id}-root`,
      name: "support-agent.run",
      layer: "agent",
      service: "agent-worker",
      pod: agPod,
      node: NODES[1],
      startMs: 28,
      durationMs: total - 60,
      status: failed ? "error" : "ok",
      attrs: { "obstack.agent.name": "support-agent", "obstack.agent.steps": 5 },
    },
    {
      id: `${id}-classify`,
      traceId: id,
      parentId: `${id}-agent`,
      name: "classify_intent",
      layer: "llm",
      service: "agent-worker",
      pod: agPod,
      node: NODES[1],
      startMs: 40,
      durationMs: classifyMs,
      status: "ok",
      attrs: { "obstack.agent.step": "classify_intent" },
      llm: {
        model: "claude-haiku-4-5",
        inputTokens: Math.round(between(rng, 280, 520)),
        outputTokens: Math.round(between(rng, 6, 14)),
        costUsd: 0.0005,
        prompt: `Classify the intent of this message: "${chat.q}"`,
        completion: pick(rng, ["account", "billing", "feature_request", "other"]),
        finishReason: "stop",
      },
    },
    {
      id: `${id}-kb`,
      traceId: id,
      parentId: `${id}-agent`,
      name: "search_kb",
      layer: "tool",
      service: "tools",
      pod: TOOLS_POD,
      node: NODES[2],
      startMs: toolStart,
      durationMs: kbMs,
      status: "ok",
      attrs: { "obstack.tool.name": "search_kb", "obstack.tool.results": Math.round(between(rng, 2, 6)) },
    },
    {
      id: `${id}-cust`,
      traceId: id,
      parentId: `${id}-agent`,
      name: "fetch_customer",
      layer: "tool",
      service: "tools",
      pod: TOOLS_POD,
      node: NODES[2],
      startMs: toolStart + 8,
      durationMs: custMs,
      status: "ok",
      attrs: { "obstack.tool.name": "fetch_customer" },
    },
    {
      id: `${id}-draft`,
      traceId: id,
      parentId: `${id}-agent`,
      name: "draft_reply",
      layer: "llm",
      service: "agent-worker",
      pod: agPod,
      node: NODES[1],
      startMs: draftStart,
      durationMs: draftMs,
      status: failed ? "error" : "ok",
      statusMessage: failed ? "provider 500: internal error" : undefined,
      attrs: { "obstack.agent.step": "draft_reply" },
      llm: {
        model: "claude-sonnet-5",
        inputTokens: inTok,
        outputTokens: failed ? 0 : outTok,
        costUsd: cost,
        prompt: `You are Loopwork's support agent. Draft a reply using retrieved context.\n\nCustomer: "${chat.q}"`,
        completion: failed ? "" : chat.a,
        finishReason: failed ? "error" : "stop",
      },
    },
    {
      id: `${id}-review`,
      traceId: id,
      parentId: `${id}-agent`,
      name: "review_reply",
      layer: "llm",
      service: "agent-worker",
      pod: agPod,
      node: NODES[1],
      startMs: reviewStart,
      durationMs: reviewMs,
      status: "ok",
      attrs: { "obstack.agent.step": "review_reply", "review.confidence": +between(rng, 0.78, 0.98).toFixed(2) },
      llm: {
        model: "claude-haiku-4-5",
        inputTokens: Math.round(between(rng, 300, 500)),
        outputTokens: Math.round(between(rng, 20, 40)),
        costUsd: 0.0006,
        prompt: "Score this draft reply for accuracy and completeness. Return JSON {confidence, flags[]}.",
        completion: `{"confidence": ${between(rng, 0.78, 0.98).toFixed(2)}, "flags": []}`,
        finishReason: "stop",
      },
    },
  ];

  const logs: LogRecord[] = [
    baseLog(`${id}-log1`, id, 35, "info", `support-agent.run started (route=${route.name.split(" ")[1]})`, agPod),
    baseLog(`${id}-log2`, id, draftStart + 10, "info", "draft_reply: streaming completion started (model=claude-sonnet-5)", agPod),
    failed
      ? baseLog(`${id}-log3`, id, draftStart + draftMs - 5, "error", "draft_reply failed: provider returned 500 internal error", agPod)
      : baseLog(`${id}-log3`, id, total - 20, "info", "support-agent.run completed (5 steps)", agPod),
  ];

  const totalTokens = spans.reduce(
    (s, sp) => s + (sp.llm ? sp.llm.inputTokens + sp.llm.outputTokens : 0),
    0,
  );

  return {
    id,
    rootName: route.name,
    method: route.method,
    service: "gateway",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: total,
    status: failed ? "error" : "ok",
    spanCount: spans.length,
    totalTokens,
    costUsd: +spans.reduce((s, sp) => s + (sp.llm?.costUsd ?? 0), 0).toFixed(4),
    services: ["gateway", "agent-worker", "tools"],
    models: ["claude-haiku-4-5", "claude-sonnet-5"],
    spans,
    logs,
    k8sEvents: maybeInfraEvent(rng, id, agPod),
  };
}

function makePlainTrace(
  rng: () => number,
  id: string,
  route: (typeof ROUTES)[number],
  startedAt: number,
): Trace {
  const failed = rng() < 0.03;
  const gwPod = pick(rng, GATEWAY_PODS);
  const cacheHit = rng() < 0.6;
  const redisMs = Math.round(between(rng, 1, 5));
  const dbMs = cacheHit ? 0 : Math.round(between(rng, 8, 60));
  const total = redisMs + dbMs + Math.round(between(rng, 10, 40));

  const spans: Span[] = [
    {
      id: `${id}-root`,
      traceId: id,
      parentId: null,
      name: route.name,
      layer: "api",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 0,
      durationMs: total,
      status: failed ? "error" : "ok",
      statusMessage: failed ? "500 Internal Server Error" : undefined,
      attrs: {
        "http.method": route.method,
        "http.route": route.name.split(" ")[1],
        "http.status_code": failed ? 500 : 200,
      },
    },
    {
      id: `${id}-redis`,
      traceId: id,
      parentId: `${id}-root`,
      name: cacheHit ? "redis.get tickets:list (hit)" : "redis.get tickets:list (miss)",
      layer: "tool",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 4,
      durationMs: redisMs,
      status: "ok",
      attrs: { "db.system": "redis", "cache.hit": cacheHit ? "true" : "false" },
    },
    ...(!cacheHit || failed
      ? [
          {
            id: `${id}-db`,
            traceId: id,
            parentId: `${id}-root`,
            name: "pg.query tickets",
            layer: "tool" as const,
            service: "gateway",
            pod: gwPod,
            node: NODES[0],
            startMs: 6 + redisMs,
            durationMs: failed ? Math.round(between(rng, 4800, 5200)) : dbMs,
            status: (failed ? "error" : "ok") as "ok" | "error",
            statusMessage: failed ? "connection pool exhausted" : undefined,
            attrs: { "db.system": "postgresql", "db.rows": Math.round(between(rng, 1, 80)) },
          },
        ]
      : []),
  ];

  return {
    id,
    rootName: route.name,
    method: route.method,
    service: "gateway",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: failed ? 5100 : total,
    status: failed ? "error" : "ok",
    spanCount: spans.length,
    totalTokens: 0,
    costUsd: 0,
    services: ["gateway"],
    models: [],
    spans,
    logs: [
      baseLog(
        `${id}-log1`,
        id,
        4,
        failed ? "error" : "debug",
        failed
          ? "pg pool: no connection available after 5000ms (pool_size=20, in_use=20)"
          : `handled ${route.name} in ${total}ms`,
        gwPod,
      ),
    ],
    k8sEvents: maybeInfraEvent(rng, id, gwPod),
  };
}

/** Webhook ingestion pipeline: verify → persist → publish. No LLM anywhere. */
function makeWebhookTrace(
  rng: () => number,
  id: string,
  route: (typeof ROUTES)[number],
  startedAt: number,
): Trace {
  const gwPod = pick(rng, GATEWAY_PODS);
  const verifyMs = Math.round(between(rng, 2, 8));
  const dbMs = Math.round(between(rng, 10, 45));
  const kafkaMs = Math.round(between(rng, 4, 18));
  const total = verifyMs + dbMs + kafkaMs + Math.round(between(rng, 8, 25));

  const spans: Span[] = [
    {
      id: `${id}-root`,
      traceId: id,
      parentId: null,
      name: route.name,
      layer: "api",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 0,
      durationMs: total,
      status: "ok",
      attrs: { "http.method": "POST", "http.route": "/v1/webhooks/zendesk", "http.status_code": 202 },
    },
    {
      id: `${id}-verify`,
      traceId: id,
      parentId: `${id}-root`,
      name: "webhook.verify_signature",
      layer: "tool",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 2,
      durationMs: verifyMs,
      status: "ok",
      attrs: { "webhook.source": "zendesk", "webhook.event": "ticket.updated" },
    },
    {
      id: `${id}-db`,
      traceId: id,
      parentId: `${id}-root`,
      name: "pg.insert ticket_events",
      layer: "tool",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 4 + verifyMs,
      durationMs: dbMs,
      status: "ok",
      attrs: { "db.system": "postgresql", "db.operation": "INSERT" },
    },
    {
      id: `${id}-kafka`,
      traceId: id,
      parentId: `${id}-root`,
      name: "kafka.publish ticket-events",
      layer: "tool",
      service: "gateway",
      pod: gwPod,
      node: NODES[0],
      startMs: 6 + verifyMs + dbMs,
      durationMs: kafkaMs,
      status: "ok",
      attrs: { "messaging.system": "kafka", "messaging.destination": "ticket-events", "messaging.partition": Math.round(between(rng, 0, 5)) },
    },
  ];

  return {
    id,
    rootName: route.name,
    method: route.method,
    service: "gateway",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: total,
    status: "ok",
    spanCount: spans.length,
    totalTokens: 0,
    costUsd: 0,
    services: ["gateway"],
    models: [],
    spans,
    logs: [
      baseLog(`${id}-log1`, id, 3, "info", "webhook received: zendesk ticket.updated", gwPod),
      baseLog(`${id}-log2`, id, total - 5, "info", "event persisted and published to ticket-events", gwPod),
    ],
    k8sEvents: maybeInfraEvent(rng, id, gwPod),
  };
}

/** Background worker job: kafka consume → batch update → cache invalidate. No API, no LLM. */
function makeWorkerTrace(
  rng: () => number,
  id: string,
  route: (typeof ROUTES)[number],
  startedAt: number,
): Trace {
  const failed = rng() < 0.05;
  const batch = Math.round(between(rng, 12, 240));
  const consumeMs = Math.round(between(rng, 3, 12));
  const dbMs = Math.round(between(rng, 40, 400));
  const redisMs = Math.round(between(rng, 2, 9));
  const total = consumeMs + dbMs + redisMs + Math.round(between(rng, 10, 40));

  const spans: Span[] = [
    {
      id: `${id}-root`,
      traceId: id,
      parentId: null,
      name: route.name,
      layer: "infra",
      service: "sync-worker",
      pod: WORKER_POD,
      node: NODES[1],
      startMs: 0,
      durationMs: total,
      status: failed ? "error" : "ok",
      statusMessage: failed ? "batch aborted: deadlock detected" : undefined,
      attrs: { "job.name": "sync-tickets", "job.batch_size": batch, "job.trigger": "kafka" },
    },
    {
      id: `${id}-consume`,
      traceId: id,
      parentId: `${id}-root`,
      name: "kafka.consume ticket-events",
      layer: "tool",
      service: "sync-worker",
      pod: WORKER_POD,
      node: NODES[1],
      startMs: 1,
      durationMs: consumeMs,
      status: "ok",
      attrs: { "messaging.system": "kafka", "messaging.batch_size": batch, "messaging.consumer_group": "sync-workers" },
    },
    {
      id: `${id}-db`,
      traceId: id,
      parentId: `${id}-root`,
      name: `pg.batch_update tickets (${batch} rows)`,
      layer: "tool",
      service: "sync-worker",
      pod: WORKER_POD,
      node: NODES[1],
      startMs: 3 + consumeMs,
      durationMs: dbMs,
      status: failed ? "error" : "ok",
      statusMessage: failed ? "40P01 deadlock_detected — retrying batch" : undefined,
      attrs: { "db.system": "postgresql", "db.operation": "UPDATE", "db.rows": failed ? 0 : batch },
    },
    ...(failed
      ? []
      : [
          {
            id: `${id}-redis`,
            traceId: id,
            parentId: `${id}-root`,
            name: "redis.del tickets:list",
            layer: "tool" as const,
            service: "sync-worker",
            pod: WORKER_POD,
            node: NODES[1],
            startMs: 6 + consumeMs + dbMs,
            durationMs: redisMs,
            status: "ok" as const,
            attrs: { "db.system": "redis", "cache.invalidated": "tickets:list" },
          },
        ]),
  ];

  return {
    id,
    rootName: route.name,
    method: route.method,
    service: "sync-worker",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: total,
    status: failed ? "error" : "ok",
    spanCount: spans.length,
    totalTokens: 0,
    costUsd: 0,
    services: ["sync-worker"],
    models: [],
    spans,
    logs: [
      baseLog(`${id}-log1`, id, 2, "info", `consuming batch of ${batch} from ticket-events (lag=${Math.round(between(rng, 0, 900))})`, WORKER_POD),
      failed
        ? baseLog(`${id}-log2`, id, total - 8, "error", "pg deadlock detected (40P01) — batch requeued with backoff", WORKER_POD)
        : baseLog(`${id}-log2`, id, total - 5, "info", `synced ${batch} tickets, cache invalidated`, WORKER_POD),
    ],
    k8sEvents: maybeInfraEvent(rng, id, WORKER_POD),
  };
}

const makers: Record<Shape, typeof makePlainTrace> = {
  agent: makeAgentTrace,
  plain: makePlainTrace,
  webhook: makeWebhookTrace,
  worker: makeWorkerTrace,
};

export function generateTraces(count: number): Trace[] {
  const rng = mulberry32(20260809);
  const out: Trace[] = [];
  for (let i = 0; i < count; i++) {
    const route = weightedRoute(rng);
    const id = hexId(rng, 16);
    // spread over the last ~6 hours, denser recently
    const ageMs = Math.pow(rng(), 1.6) * 6 * 3600_000;
    const startedAt = NOW - ageMs;
    out.push(makers[route.shape](rng, id, route, startedAt));
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
