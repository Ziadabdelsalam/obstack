import { between, hexId, mulberry32, pick } from "./rand";
import type { LogRecord, Span, Trace } from "./types";

/** Fixed anchor so SSR and client render identically. */
export const NOW = Date.parse("2026-08-09T13:40:00.000Z");

const ROUTES = [
  { name: "POST /v1/tickets/{id}/reply", method: "POST", agent: true, weight: 4 },
  { name: "POST /v1/chat", method: "POST", agent: true, weight: 5 },
  { name: "POST /v1/webhooks/zendesk", method: "POST", agent: true, weight: 2 },
  { name: "GET /v1/tickets", method: "GET", agent: false, weight: 4 },
  { name: "GET /v1/tickets/{id}", method: "GET", agent: false, weight: 3 },
  { name: "POST /v1/tickets/bulk", method: "POST", agent: true, weight: 1 },
] as const;

const PODS = [
  "agent-worker-7d9fb-kx2rq",
  "agent-worker-7d9fb-m8xzt",
  "agent-worker-7d9fb-p2vnc",
  "gateway-84c5f-jw6th",
];

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

function makeAgentTrace(rng: () => number, id: string, route: (typeof ROUTES)[number], startedAt: number): Trace {
  const chat = pick(rng, CHAT_PROMPTS);
  const failed = rng() < 0.08;
  const pod = pick(rng, PODS.slice(0, 3));

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
      id: `${id}-agent`,
      traceId: id,
      parentId: `${id}-root`,
      name: "support-agent.run",
      layer: "agent",
      service: "agent-worker",
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
    {
      id: `${id}-log1`,
      traceId: id,
      atMs: 35,
      severity: "info",
      body: `support-agent.run started (route=${route.name.split(" ")[1]})`,
      namespace: "loopwork-prod",
      pod,
      container: "app",
    },
    {
      id: `${id}-log2`,
      traceId: id,
      atMs: draftStart + 10,
      severity: "info",
      body: "draft_reply: streaming completion started (model=claude-sonnet-5)",
      namespace: "loopwork-prod",
      pod,
      container: "app",
    },
    ...(failed
      ? [
          {
            id: `${id}-log3`,
            traceId: id,
            atMs: draftStart + draftMs - 5,
            severity: "error" as const,
            body: "draft_reply failed: provider returned 500 internal error",
            namespace: "loopwork-prod",
            pod,
            container: "app",
          },
        ]
      : [
          {
            id: `${id}-log3`,
            traceId: id,
            atMs: total - 20,
            severity: "info" as const,
            body: "support-agent.run completed (5 steps)",
            namespace: "loopwork-prod",
            pod,
            container: "app",
          },
        ]),
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
  };
}

function makePlainTrace(rng: () => number, id: string, route: (typeof ROUTES)[number], startedAt: number): Trace {
  const failed = rng() < 0.03;
  const dbMs = Math.round(between(rng, 8, 60));
  const total = dbMs + Math.round(between(rng, 12, 45));
  const spans: Span[] = [
    {
      id: `${id}-root`,
      traceId: id,
      parentId: null,
      name: route.name,
      layer: "api",
      service: "gateway",
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
      id: `${id}-db`,
      traceId: id,
      parentId: `${id}-root`,
      name: "pg.query tickets",
      layer: "tool",
      service: "gateway",
      startMs: 6,
      durationMs: dbMs,
      status: failed ? "error" : "ok",
      statusMessage: failed ? "connection pool exhausted" : undefined,
      attrs: { "db.system": "postgresql", "db.rows": Math.round(between(rng, 1, 80)) },
    },
  ];
  return {
    id,
    rootName: route.name,
    method: route.method,
    service: "gateway",
    startedAt: new Date(startedAt).toISOString(),
    durationMs: total,
    status: failed ? "error" : "ok",
    spanCount: spans.length,
    totalTokens: 0,
    costUsd: 0,
    services: ["gateway"],
    models: [],
    spans,
    logs: [
      {
        id: `${id}-log1`,
        traceId: id,
        atMs: 4,
        severity: failed ? "error" : "debug",
        body: failed
          ? "pg pool: no connection available after 5000ms (pool_size=20, in_use=20)"
          : `handled ${route.name} in ${total}ms`,
        namespace: "loopwork-prod",
        pod: "gateway-84c5f-jw6th",
        container: "app",
      },
    ],
  };
}

export function generateTraces(count: number): Trace[] {
  const rng = mulberry32(20260809);
  const out: Trace[] = [];
  for (let i = 0; i < count; i++) {
    const route = weightedRoute(rng);
    const id = hexId(rng, 16);
    // spread over the last ~6 hours, denser recently
    const ageMs = Math.pow(rng(), 1.6) * 6 * 3600_000;
    const startedAt = NOW - ageMs;
    out.push(
      route.agent
        ? makeAgentTrace(rng, id, route, startedAt)
        : makePlainTrace(rng, id, route, startedAt),
    );
  }
  return out.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
