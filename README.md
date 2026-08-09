# obstack

**Every layer. One trace.** Observability for AI software — obstack joins your API, agents, LLM calls, and infrastructure into a single correlated trace.

This repo currently contains **Phase 0: the frontend prototype** — a marketing landing page plus the full app UI running on realistic mock data (no backend). It exists to make the product tangible: for design iteration, design-partner conversations, and fundraising.

## Run it

```bash
npm install
npm run dev
```

- `/` — landing page
- `/app` — the product mock (overview, traces, unified trace view, connections, quickstart)

Best demo path: open `/app/traces/a3f8c1d92b6e407f` (the OOM-kill story) and hit **Explain this trace**.

## What's real vs. mock

Everything visual is real code (Next.js + Tailwind + Recharts). All data is fictional, generated deterministically in `src/mock/` — including three scripted failure stories that demonstrate cross-layer correlation (pod OOM-kill → truncated completion → 502; tool-timeout retry chain; provider rate-limit cascade).

## Documents

- Product spec: `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md`
- Vision/fundraising: `docs/superpowers/specs/2026-08-09-obstack-vision-prd.md`
- This phase's plan: `.planning/2026-08-09-phase0-frontend-prototype-plan.md`
- Screenshots: `docs/screenshots/`
