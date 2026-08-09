# obstack — Vision PRD (fundraising altitude)

**Date:** 2026-08-09
**Status:** Approved design
**Audience:** Investors, future hires, design partners. The narrative and phased ambition. The buildable v1 contract lives in `2026-08-09-obstack-execution-prd.md`.

---

## 1. The thesis

Software is becoming agentic — and the debugging story has fallen apart.

A modern AI product is a stack of layers that don't speak to each other: an API edge, an orchestration/agent layer making multi-step decisions, LLM calls whose behavior is probabilistic, and containers/Kubernetes underneath it all. When something breaks, the **symptom surfaces in one layer and the cause hides in another**: a pod OOM-kill becomes a truncated completion becomes a hallucinated tool call becomes a corrupted user session. Today's tooling splits this stack across three markets — infra observability (Datadog, Grafana), LLM observability (Langfuse, Helicone, Braintrust), and raw logs — and leaves the joins to humans with six tabs open.

**obstack's bet: the correlated trace is the atomic unit of understanding AI software.** One trace, from the user's request down to the pod it ran on, with every agent decision and LLM call inline. Whoever owns that join owns the operations layer for AI software.

## 2. Why now

- Agentic products moved from demos to production; debugging them is the loudest unsolved pain in AI engineering communities.
- OpenTelemetry won. GenAI semantic conventions landed. For the first time, the AI layer and the infra layer can share a wire format — nobody has built the product that exploits it end-to-end.
- The incumbents are structurally mispositioned: infra vendors bolt on LLM features priced for enterprises; LLM-obs startups have no infra story. The join is a gap, not a feature race.

## 3. Market

- Observability is a $50B+ market growing double digits; AI observability is its fastest-growing slice.
- Beachhead: **AI startups** (2–20 engineers, Docker/K8s, no entrenched Datadog contract) — acute pain, fast adoption.
- Expansion: mid-size orgs adding AI features (SSO/SOC2 unlock), then platform teams standardizing obstack org-wide.
- Wedge dynamics favor entry: OTel-native means adopting obstack is one environment variable for already-instrumented teams — near-zero switching cost inbound.

## 4. Product vision (phased)

**Phase 1 — See (v1, execution PRD).** The unified trace view: OTel-native ingestion of LLM calls, agent traces, Docker/K8s logs, and API spans; correlation by trace context; search; cost/latency/error dashboard; one AI feature — "Explain this trace," a root-cause summary built from the correlated data. Cloud SaaS for small teams; identical self-hosted bundle for larger and privacy-sensitive ones.

**Phase 2 — Watch.** Alerting and anomaly detection tuned to AI workloads: error-rate and latency alerts, but also token-spend spikes, cost-per-feature drift, agent-loop detection, tool-failure clustering.

**Phase 3 — Ask.** Natural-language operations: "why did checkout fail for EU users last night?" answered with evidence from traces and logs. The Explain feature generalized from one trace to the whole system.

**Phase 4 — Learn.** Production evals: regression detection on live traces, "this deploy made the agent worse" as a first-class signal, cost-optimization recommendations (model routing, prompt trimming) grounded in real traffic.

**Long-term arc:** the operations layer for AI software — a system that doesn't just show you what broke, but tells you, and learns what "broken" means for *your* agents.

## 5. Business model

- **Cloud (small teams):** free tier (50k events/mo) → usage-based Pro ($49/mo + volume) → Scale (volume pricing, longer retention). Revenue scales with customer success, the proven pattern of the segment.
- **Self-hosted (larger / privacy-sensitive teams):** annual license, ~$10k+/yr anchor. Same images as cloud — one codebase, two motions.
- **Explain/AI features** are tier-gated — the intelligence layer is the upsell, ingestion is the funnel.

## 6. Go-to-market

- Bottom-up, developer-led: demo video of the hero trace view, Show HN, AI-engineering communities, quickstart-first docs.
- Design-partner program (5–10 AI startups) shapes the roadmap and produces the case studies.
- Self-hosted bundle doubles as the enterprise trial motion.
- Future distribution lever under consideration: open-sourcing the SDKs/collector (likely) or the core (undecided) — the PostHog/Langfuse playbook, to be decided on traction data rather than at launch.

## 7. Moat

1. **The join as the default posture** — competitors treat correlation as a feature; obstack's data model, UX, and AI layer all assume it. Retrofitting that is a rebuild.
2. **Correlated data compounds:** every layer a customer connects makes Explain/Ask/Learn smarter, and multi-layer telemetry makes leaving costlier.
3. **OTel-native asymmetry:** near-zero switching cost inbound, standard-format credibility, and no re-instrumentation objection in the sales motion.

## 8. Traction plan & metrics

- **First 90 days (v1):** 25 teams activated (correlated trace within 30 min of signup); ≥3 design partners in daily production use; signup→first-trace >40%.
- **Months 4–9:** first paying cohort, Phase 2 (alerting) shipped, first self-hosted enterprise deal.
- **Months 9–18:** Phase 3 (Ask), SSO/SOC2 unlock for mid-market, expansion revenue from retention/volume tiers.

## 9. Team & ask

- Built solo-plus-AI-agents to v1 — the execution PRD is deliberately scoped to prove the wedge with one operator; capital accelerates the Phase 2–4 roadmap, design-partner coverage, and the first hires (founding engineer, DX engineer).
- The ask and round mechanics are intentionally out of this document's scope; this PRD is the product half of the fundraising narrative.
