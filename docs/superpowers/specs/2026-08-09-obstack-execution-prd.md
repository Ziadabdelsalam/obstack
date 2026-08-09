# obstack — Execution PRD (v1)

**Date:** 2026-08-09
**Status:** Approved design, pre-implementation
**Audience:** The builder (solo + AI agents). This document is the self-contained brief for implementation planning — an executor should be able to act on it without re-deriving decisions.
**Companion doc:** `2026-08-09-obstack-vision-prd.md` (fundraising/vision altitude).

---

## 1. One-liner

obstack is the observability platform that shows AI teams the **whole** story of a request — from the API call, through every agent step and LLM call, down to the container it ran on — in a single correlated trace.

## 2. Problem

Teams shipping LLM/agent products debug across three or more disconnected tools: an LLM-observability tool (Langfuse, Helicone) for prompts and tokens, an infra tool (Datadog, Grafana) for containers and pods, and raw `kubectl logs` / `docker logs` for everything else. When an agent fails, the **cause** is often in one layer (a pod OOM-kill, a timeout at the API edge) while the **symptom** appears in another (a truncated LLM completion, a hallucinated tool result). Nothing joins these layers. Correlation today is manual: tab-hopping, timestamp-squinting, guesswork.

**Core wedge:** unified correlation. One trace across API → agent → LLM → infra. The correlated trace *is* the product; every other feature serves it.

## 3. Target customer (ICP)

**AI startups**: teams of 2–20 engineers shipping LLM/agent products on Docker or Kubernetes. They feel the correlation pain acutely, adopt fast, tolerate rough edges, and have no entrenched Datadog contract. Fast-follow segments (not v1): mid-size orgs adding AI features (will demand SSO/SOC2 — noted in roadmap, not launch-gated).

## 4. Delivery model

- **Cloud SaaS** — default path for small teams. Managed, usage-billed.
- **Self-hosted** — for bigger teams and privacy-sensitive customers (teams that will not ship prompts/logs to a third party). Annual license.
- **Hard constraint:** cloud and self-hosted run the **same images from the same repo**. One docker-compose bundle (dev + small self-hosted), one Helm chart (self-hosted K8s). Self-hosted = same product minus managed billing. This is a day-one architectural constraint, not a later port.

## 5. V1 scope

### In scope

**Ingest**
- OTLP endpoint (HTTP/protobuf + gRPC) accepting traces and logs.
- `obstack-collector`: a preconfigured OpenTelemetry Collector **distribution (config, not fork)** — one container (Docker) / one DaemonSet (K8s) that tails container stdout/stderr, attaches pod/container metadata via the `k8sattributes` processor, and exports OTLP to obstack.
- SDKs: `obstack-py` (Python) and `obstack-js` (TypeScript) — **thin layers over the standard OTel SDKs**, zero lock-in (standard OTLP underneath):
  - Auto-instrumentation for OpenAI, Anthropic, and Vercel AI SDK calls, emitting spans per OTel **GenAI semantic conventions** (prompt, completion, model, tokens, cost, latency, error).
  - `@trace_agent` / `traceAgent` decorators for agent steps and tool calls (step name, tool inputs/outputs, retries), forming the tree above individual LLM calls.
- "Bring your own OTel" path: existing OTel users point `OTEL_EXPORTER_OTLP_ENDPOINT` + an auth header at obstack and it works with no SDK.

**Correlation**
- Primary key: W3C `trace_id` propagated end-to-end (standard OTel context propagation).
- Fallback join for logs without trace context: (namespace/pod/container) + ±time-window, surfaced in the UI as "nearby" (visually distinct from solid trace_id matches).

**Experience**
- **Unified trace view** (hero screen — see §8).
- Trace/log **search** with filters + saved views.
- **Overview dashboard**: requests & error rate, p50/p95 latency, token spend & LLM cost over time, top failing routes/agents.
- **"Explain this trace"** — the single v1 AI feature (see §8).

**Connections hub**
- A first-class **Connections** area: a catalog of every log/telemetry source a user might run, each opening a guided connect flow. Users wire their sources to obstack here — this replaces a docs-only integration story.
- **v1-functional connectors:** Generic OTLP (any OTel SDK/collector), Docker (obstack-collector container), Kubernetes (obstack-collector DaemonSet), Vercel (log drains), AWS CloudWatch Logs (subscription → forwarder).
- **Catalog-visible, roadmap-gated** (shown with "Request access"/"Coming soon" and a vote/request button — doubles as demand signal): GCP Cloud Logging, Azure Monitor, Railway, Fly.io, Render, Supabase, Postgres, MongoDB, Kafka, Redis, GitHub Actions, LLM gateways (OpenRouter, Vercel AI Gateway), Cloudflare Workers.
- Each connection shows live status once connected: last event received, event rate, error count.

**Product shell**
- Auth, orgs/workspaces, team invites, API keys.
- Usage metering; free tier + usage-based billing via Stripe.
- Onboarding flow engineered around time-to-first-correlated-trace (see §8).
- Self-hosted bundle (compose + Helm) and docs.

### Out of scope (v1)

Metrics ingestion (beyond derived metrics); alerting/notifications; natural-language querying; evals/prompt management; SSO/SAML and SOC2 (fast-follow — on roadmap, not launch-gated); RUM/frontend observability; mobile; sampling controls beyond a single simple rate.

## 6. Architecture

Approach: **ClickHouse-core** (chosen over Postgres-only and assemble-on-OSS after explicit trade-off review).

### Components

1. **`ingest`** — stateless OTLP service (Go). Validates API keys, enriches spans/logs with workspace ID, batches, writes to ClickHouse. Horizontally scalable. **No queue in v1** — ClickHouse async inserts absorb burst; Kafka/Redpanda is a documented scale-out path, not a launch dependency.
2. **ClickHouse** — telemetry store. Tables:
   - `spans` — all spans (API, agent, LLM), GenAI attributes as columns/attribute map.
   - `logs` — log records with resource attributes (pod, container, namespace) and optional trace_id.
   - `trace_summaries` — materialized per-trace rollup powering search: root span, status, duration, total tokens/cost, services touched.
   - Retention via TTL: 30-day default, per-pricing-tier.
3. **Postgres** — app data: orgs/workspaces, users, API keys, saved views, billing state, usage counters.
4. **`web`** — Next.js app: auth, trace view, search, dashboard, settings. Queries ClickHouse **read-only through a thin internal query layer**; no raw client-to-ClickHouse access.
5. **`obstack-collector`** — the preconfigured OTel Collector distro described in §5.
6. **SDKs** — `obstack-py` / `obstack-js` as described in §5.
7. **`explain`** — server-side function: assembles a failed trace's spans + correlated logs into a prompt, returns a structured root-cause summary. Uses Claude via API in cloud; **model configurable in self-hosted** (customer's own key/endpoint).

### Data flow

app/SDK & collector → OTLP → `ingest` → ClickHouse → `web` (query layer) → trace view. Postgres sits beside the flow for identity/billing; `explain` reads from the query layer on demand.

## 7. Data model notes

- Spans follow OTel span schema + GenAI semantic conventions; agent steps are ordinary spans with obstack attribute namespace (`obstack.agent.step`, `obstack.tool.name`, …) so foreign OTLP remains fully compatible.
- Cost is computed at ingest from model + token counts using a maintained pricing table (overridable per workspace for custom models).
- `trace_summaries` is the search surface — search never scans raw `spans` for the list view.

## 8. Experience specification

### Onboarding (activation is engineered here)

Target: **signup → first correlated trace in under 30 minutes.**

1. Sign up → workspace auto-created → API key shown with a three-tab quickstart: Python / TypeScript / "I already have OTel".
2. Paths: existing-OTel = one env var change; SDK = install + 2 lines; infra = one `helm install` or one compose service.
3. A live "waiting for data…" screen flips to the user's actual first trace the moment spans arrive. The aha moment is engineered, not left to chance.

### Unified trace view (hero)

- Waterfall/tree of a single trace.
- API spans: method, route, status. Agent spans: step name, tool calls, retries. LLM spans: expand inline to full prompt/completion, model, tokens, cost, latency.
- **Logs rail**: correlated container logs aligned to the trace timeline. trace_id matches render solid; time-window matches labeled "nearby."
- Failed spans auto-expand. Copy-link shares the exact view.

### Search

Filter bar over `trace_summaries`: service, status, duration, model, cost range, free-text over prompts/logs, time range. Saved views per workspace.

### Overview dashboard

Requests & error rate, p50/p95 latency, token spend and LLM cost over time, top failing routes/agents. Every chart click lands in filtered search → trace view.

### Connections hub

Catalog grid of all sources (searchable, grouped: Cloud, PaaS, Containers & K8s, Databases, LLM & AI, Queues & Events, CI/CD). Each card → guided connect flow (keys/config/one-liner install) for v1-functional connectors, or "Coming soon + request" for roadmap ones. Connected sources list shows live health: last event, rate, errors. The onboarding quickstart (§ Onboarding) is a curated slice of this hub.

### Explain this trace

Button on any failed trace. Streams a structured summary: **what failed → where in the stack → likely root cause → evidence** (linked spans/log lines). Rate-limited per pricing tier.

## 9. Error-handling posture (product-level)

- **Ingest is never the customer's outage.** Malformed data is dropped and counted in a visible per-workspace ingest-errors counter — never a 500-retry loop.
- **SDKs fail open.** Worst case is telemetry loss, never customer-app breakage.
- **Quota-exceeded degrades**, to sampled ingestion with a UI banner — not a hard cut.

## 10. Pricing (launch hypotheses — to be validated with design partners)

Billing unit: an **event** = one span or one log record.

| Tier | Price | Includes |
|---|---|---|
| Free | $0 | 50k events/mo, 7-day retention, 2 seats, 20 Explain runs/mo |
| Pro | $49/mo base | 1M events incl., then ~$1.50 per additional 100k; 30-day retention; unlimited seats; 200 Explain runs |
| Scale | Volume pricing | 90-day retention, priority support |
| Self-hosted Enterprise | Annual license, anchor ~$10k+/yr | Unlimited volume on their hardware; SSO when it ships |

## 11. Go-to-market (v1, solo-compatible)

- Launch demo video of the hero trace view ("watch one click explain a failed agent").
- Show HN + AI-engineering communities.
- Quickstart-first docs site.
- 5–10 design partners recruited directly from AI-startup networks.
- The self-hosted bundle doubles as the trial motion for privacy-sensitive teams.
- Positioning line: **"Point your existing OpenTelemetry at us — obstack is where the AI layer and the infra layer finally meet."**

## 12. Success metrics (first 90 days)

- **Primary:** 25 teams reach a correlated trace (≥2 layers joined) within 30 minutes of signup.
- Signup → first-trace conversion > 40%.
- Weekly-returning workspaces > 50% of activated.
- ≥3 design partners using obstack daily in production.
- Median time-to-first-trace < 15 minutes.

## 13. Execution roadmap (solo + AI agents)

| Phase | Deliverable | Exit criterion |
|---|---|---|
| 0. Frontend prototype | Landing page + full app UI with realistic mock data (trace view, search, dashboard, Connections hub, onboarding) — dark, dense dev-tool aesthetic | The whole product is walkable end-to-end in a browser; used to refine the design and as the visual for fundraising/design-partner conversations |
| 1. Core pipeline | `ingest` + ClickHouse schema + trace view wired to real data | An OTLP-instrumented demo app's trace renders end-to-end (internal demo quality) |
| 2. Correlation complete | Collector distro, log joins, SDK auto-instrumentation, search | Demo app on K8s shows API→agent→LLM spans with correlated pod logs in one view |
| 3. Product shell | Auth/workspaces/keys, onboarding flow, dashboard, Connections hub (functional connectors), Explain, Stripe billing | A stranger can sign up, connect a source, and reach a correlated trace unassisted |
| 4. Launch hardening | Self-hosted bundle, docs site, public demo environment, design-partner onboarding | First 5 design partners activated; public launch |

Each phase gets its own implementation plan (via writing-plans) before build.

## 14. Risks & mitigations

- **Scope (four sources, solo builder).** Mitigation: thin on each source, deep on the join; OTel supplies the ingestion breadth; phases gate scope.
- **ClickHouse ops burden.** Mitigation: single-node CH is low-maintenance at startup scale; ClickHouse Cloud available for the SaaS side.
- **Incumbent response** (Datadog LLM obs, Langfuse adding infra). Mitigation: speed + the join as default posture, not a bolted-on feature; OTel-native means switching cost is one env var — in obstack's favor for acquisition.
- **Free-tier abuse / cost blowout.** Mitigation: hard metering at ingest, sampled degradation, retention TTLs.
- **Explain quality.** Mitigation: structured prompt over correlated data (obstack has strictly more context than generic tools); rate limits bound cost.

## 15. Open questions (tracked, not blocking)

- OSS wedge: keep proprietary at launch; revisit open-sourcing SDKs+collector config (likely) vs. full core (undecided) once traction data exists.
- Exact Scale-tier pricing mechanics — set with first volume customers.
- Python-first vs. parallel TS launch for SDK polish depth — decide in Phase 2 planning.
