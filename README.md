# obstack

**Every layer. One trace.** Observability for AI software — obstack joins your API, agents, LLM calls, and infrastructure into a single correlated trace.

This repo contains **Phase 0**, the frontend prototype — a marketing landing page plus the full app UI on realistic mock data — and **Phase 1**, the core pipeline: an OTLP ingest service writing to ClickHouse, which the traces and overview surfaces read for real.

## Run it (mock data)

```bash
npm install
npm run dev
```

- `/` — landing page
- `/app` — the product mock (overview, traces, unified trace view, connections, quickstart)

Best demo path: open `/app/traces/a3f8c1d92b6e407f` (the OOM-kill story) and hit **Explain this trace**.

## Run the real pipeline

Phase 1 is a working backend: a Go OTLP receiver (`services/ingest/`) that maps spans and logs into ClickHouse, and a Python demo agent (`demo/agent-app/`) instrumented with nothing but the standard OpenTelemetry SDK — proof of the bring-your-own-OTel path. Prerequisites are Docker and the `npm install` above — the assertion runs against the app's own data facade, from this repo's `node_modules`.

```bash
bash deploy/compose/smoke.sh
```

That boots ClickHouse, ingest and the demo app, sends the demo one `POST /chat`, and asserts through the app's own data facade that the resulting trace both lists and resolves with all four layers — `api`, `agent`, `tool`, `llm` — under one `trace_id`, an LLM span carrying model, prompt, completion and non-zero token counts, a non-zero cost priced at ingest, and correlated logs. It is the Phase 1 exit criterion; it exits non-zero with the specific failure otherwise.

To browse that trace in the real UI, with the stack still up:

```bash
OBSTACK_DATA_MODE=live \
CLICKHOUSE_URL=http://127.0.0.1:8123 \
CLICKHOUSE_USER=obstack_web \
CLICKHOUSE_PASSWORD=obstack_web_dev \
  npm run dev
```

Point your own service at `http://localhost:4318` (OTLP/HTTP) or `:4317` (gRPC) with `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local` and its traces show up the same way. Details, users, schema and the manual verification checklist: `deploy/compose/README.md`.

## What's real vs. mock

Everything visual is real code (Next.js + Tailwind + Recharts). With `OBSTACK_DATA_MODE=live` the traces list, the trace view and the overview charts read ingested telemetry from ClickHouse; every surface not yet wired to the pipeline is marked with a `SAMPLE DATA` badge in the UI. In the default mock mode all data is fictional, generated deterministically in `src/mock/` — including three scripted failure stories that demonstrate cross-layer correlation (pod OOM-kill → truncated completion → 502; tool-timeout retry chain; provider rate-limit cascade).

## Documents

- Product spec: `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md`
- Vision/fundraising: `docs/superpowers/specs/2026-08-09-obstack-vision-prd.md`
- This phase's plan: `.planning/2026-08-09-phase0-frontend-prototype-plan.md`
- Screenshots: `docs/screenshots/`
