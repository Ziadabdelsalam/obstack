# Phase 0 — Frontend Prototype Plan (landing page + full app mock)

**Date:** 2026-08-09
**Source spec:** `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md` (§8 Experience, Connections hub, roadmap Phase 0)
**Goal:** The whole obstack product walkable end-to-end in a browser — marketing landing page plus the app UI on realistic mock data. No backend, no auth, no database. Used to refine the design, and as the visual asset for fundraising and design-partner conversations.

This brief is self-contained: an executor should build from it without re-deriving decisions.

---

## Decisions already made

- **Aesthetic:** dark-first, dense dev-tool (Linear/Vercel/Grafana energy). High data density, monospace accents for identifiers/numbers, sharp and technical. Landing page and app share one visual language. Load the `frontend-design` skill before building UI; load `dataviz` before any chart.
- **Stack:** Next.js (App Router) + TypeScript + Tailwind + shadcn/ui. Charts: Recharts. No state library — mock data is static imports; URL params carry view state where sharing matters (e.g., selected trace/span).
- **One app, two zones:** `/` = landing (marketing), `/app/*` = product mock. No auth gate — landing "Get started" links straight into `/app`.
- **Mock data is the product's credibility.** It must look like a real AI startup's production: a demo company ("Loopwork — AI support-agent SaaS") with realistic traces (API → agent steps → tool calls → LLM calls), correlated K8s pod logs, believable latencies/token counts/costs, and a handful of interesting failures (an OOM-killed pod truncating a completion; a tool-call timeout retry chain; a rate-limit cascade). Mock data lives in typed fixtures (`src/mock/`) with generator scripts, not hand-scattered inline.

## Screens to build

### Landing page (`/`)
1. **Hero:** one-liner ("See the whole story of every request — from API to agent to LLM to the pod it ran on"), positioning subline, CTA → `/app`, and the hero visual: an embedded/animated rendition of the unified trace view (can be a styled static composition of the real app components).
2. **Problem strip:** the three-disconnected-tools pain, told in one horizontal graphic (LLM tool / infra tool / kubectl tabs → obstack join).
3. **Feature sections (3):** Unified trace view · Connections hub (catalog wall of source logos) · Explain this trace (before/after style panel).
4. **How it works:** 3 steps — point your OTel / drop the collector / connect your sources.
5. **Pricing section:** Free / Pro $49 / Scale / Self-hosted — from PRD §10.
6. **Footer** with fake-but-plausible links (docs, GitHub, etc. can be `#`).

### App mock (`/app/*`)
1. **`/app` — Overview dashboard:** stat row (requests, error rate, p95 latency, LLM cost today), charts (requests & errors over time, latency percentiles, token spend/cost, top failing routes/agents). Chart clicks deep-link into filtered search.
2. **`/app/traces` — Search:** filter bar (service, status, duration, model, cost, free-text, time range), results table from `trace_summaries`-shaped mock rows, saved-views dropdown.
3. **`/app/traces/[id]` — Unified trace view (HERO — most effort here):** waterfall/tree with span type styling (API/agent/tool/LLM); LLM spans expand inline to prompt/completion, model, tokens, cost; failed spans auto-expanded; **logs rail** aligned to the timeline with solid (trace_id) vs "nearby" (time-window) matches; "Explain this trace" button → streams a pre-scripted structured explanation (typed-out effect) for the failure traces.
4. **`/app/connections` — Connections hub:** searchable catalog grid grouped by category (Cloud, PaaS, Containers & K8s, Databases, LLM & AI, Queues & Events, CI/CD); v1-functional connectors (OTLP, Docker, Kubernetes, Vercel, AWS CloudWatch) open a guided connect-flow modal (steps + copyable config snippets); roadmap connectors show "Coming soon + Request". Connected-sources list with live-looking health (last event, rate, errors).
5. **`/app/onboarding` — Quickstart:** three-tab (Python / TypeScript / existing OTel) with copyable snippets and the "waiting for data…" → first-trace flip (simulated after a delay).
6. **App shell:** left nav (Overview, Traces, Connections, Settings stub), workspace switcher (mock), top command-bar affordance (visual only).

## File layout

```
src/
  app/
    (marketing)/page.tsx            # landing
    app/ layout.tsx                 # app shell (nav, workspace)
    app/page.tsx                    # dashboard
    app/traces/page.tsx             # search
    app/traces/[id]/page.tsx        # trace view
    app/connections/page.tsx        # connections hub
    app/onboarding/page.tsx         # quickstart
  components/
    trace/ …                        # waterfall, span row, span detail, logs rail, explain panel
    charts/ …                       # dashboard charts (dataviz-skill compliant)
    connections/ …                  # catalog card, connect-flow modal
    marketing/ …                    # landing sections
  mock/
    company.ts traces.ts logs.ts connectors.ts explanations.ts
    generate.ts                     # deterministic generators for volume data
```

## Build order (each step ends runnable)

1. Scaffold Next.js app + Tailwind + shadcn; design tokens (dark palette, type scale, mono accents); app shell with nav.
2. Mock data layer (`src/mock/`) — types first (Span, Trace, LogRecord, Connector), then fixtures incl. the 3 scripted failure stories.
3. **Unified trace view** (hero — build first among screens, everything else supports it).
4. Search page + deep links.
5. Dashboard + charts.
6. Connections hub + connect-flow modals.
7. Onboarding quickstart.
8. Landing page (reuses app components for the hero visual).
9. Polish pass: responsive check, empty states, loading shimmer, light-mode nice-to-have only if cheap.

## Explicitly out of scope (this phase)

Auth, backend/API routes, real data, persistence, billing UI beyond the pricing section, settings beyond a stub, light theme parity, mobile-first optimization (desktop-first; must not be broken on tablet).

## Exit criterion (from PRD Phase 0)

A visitor can land on `/`, click into `/app`, browse the dashboard, search traces, open a failed trace, watch "Explain this trace" produce a root-cause story over correlated spans + pod logs, and browse/“connect” sources in the Connections hub — all feeling like a real product.

## If execution hits something unplanned

Stop and check in (per working agreement) rather than improvising — especially on design-direction pivots or scope adds.
