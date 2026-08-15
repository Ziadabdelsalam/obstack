# obstack Backend Build — Product Vision & Sprint Plan

meta:
- date: 2026-08-15
- repo/branch: master @ ac75db3
- source of truth: advisor founding doc (BINDING — M1–M4, D1–D16, A1–A10, critical items, risks) + `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md`
- owner: project manager (plan only — no implementation)

## FINAL GOAL VISION

obstack's backend is built when a real request — API call through every agent step and LLM call down to the container it ran on — arrives over standard OTLP, lands in ClickHouse, and renders as one correlated trace in the shipped product, on cloud and self-hosted from the same images, well enough that 25 teams reach a correlated trace (≥2 layers joined) within 30 minutes of signup, signup→first-trace conversion clears 40%, and median time-to-first-trace is under 15 minutes.

## Sprints

### S1 — M1 Core Pipeline (PRD Phase 1)
- milestone: M1 — Core Pipeline
- type: dev
- status: planned
- dependencies: —
- run-goal (verbatim to dev-team): obstack Phase 1 Core Pipeline — OTLP→ingest→ClickHouse→trace view end-to-end (exit: demo app trace renders in real TraceExplorer via smoke.sh).
- executable plan: `/private/tmp/claude-501/-Volumes-SSD-Workspace-observer-stack/9053756b-13fb-45d6-9bbf-d214bd174313/scratchpad/team-plan.md` (T1–T10, 7 waves)
- exit criterion (PRD-binding): `docker compose up` (clickhouse + ingest + demo profile), hit the demo app's `/chat`, open `/app/traces` in live mode, click the trace — the full API→agent→tool→LLM waterfall with correlated logs renders in the existing `TraceExplorer`. Verified by the scripted smoke check, not by hand.
- scope fence: everything off the trace/search/overview path (services, on-call, dashboards, SLOs) stays on mock in Phase 1 — no partial wiring of secondary surfaces.

Tasks (product-level outcomes; 1:1 with founding-doc areas A1–A10):
- S1.1 (T1 / A1): Compose foundation with a pinned-LTS ClickHouse, split `obstack_ingest` (write) and `obstack_web` (readonly=2) users — accept: `docker compose up clickhouse` healthy; web user rejected on INSERT.
- S1.2 (T2 / A2): Ingest binary boots, applies the D7 schema idempotently via tracked migrations, serves `/healthz` + `/metrics` — accept: fresh boot creates all three tables + MV; second boot is a no-op; multi-batch INSERT rolls up to one correct `trace_summaries` row via GROUP BY + `-Merge`.
- S1.3 (T3 / A3): OTLP receive on gRPC :4317 and HTTP :4318 (`/v1/traces`, `/v1/logs`, protobuf + JSON) with bearer-key auth and the D6 error posture — accept: valid fixture 200/OK per transport, garbage → 400 + counter, bad key → 401, `telemetrygen` accepted.
- S1.4 (T4 / A4): pdata→rows mapping with layer classification, GenAI extraction, and the micro-batch writer, consuming S1.11's pricing package — accept: fixture with API+agent+tool+LLM spans and logs lands correctly typed rows; cost matches the pricing table; split-batch rollup correct; unpriced model → cost 0 + counter.
- S1.5 (T5 / A5): Telemetry view-model types are the UI contract at `src/lib/types.ts`, not under `mock/` — accept: build + lint clean; zero remaining imports of moved types from `@/mock/types`.
- S1.6 (T6 / A6): Server-only query layer + adapters + live/mock facade returning existing UI shapes from ClickHouse — accept: adapter unit tests; `getTrace` offsets correct against seeded data; `TraceExplorer` renders with `explanation`/`k8sEvents` undefined.
- S1.7 (T7 / A7): Traces list + trace detail run on the facade, server-side filtering over `trace_summaries` in live mode — accept: live mode lists ingested traces and renders the full waterfall + logs rail; mock mode unchanged.
- S1.8 (T8 / A8): Overview stat cards and requests/error/latency/cost charts computed from `trace_summaries` in live mode — accept: live numbers reconcile with direct `SELECT` totals for the same window.
- S1.9 (T9 / A9): Demo agent app emits the four-layer trace plus trace-contexted logs using plain OTel env config and a fake LLM by default — accept: `--profile demo up` + `curl POST /chat` → all four layers under one trace_id with prompt/completion/tokens; log rows carry the trace_id.
- S1.10 (T10 / A10): One-command acceptance bundle + runbook proving the Phase 1 exit criterion via the D17 tsx facade harness, including the row-level four-layer + correlated-log assertion — accept: smoke script green from a clean checkout; screenshot of a real trace in `TraceExplorer` attached to the PR.
- S1.11 (T11 / A4-split, advisor D18): Self-contained pricing package — embedded `prices.json` + longest-prefix matcher with response-model fallback — accept: pricing unit tests green including unpriced→0 + counter.

Critical items returning to the advisor before merge: T2 (DDL), T4 (mapping + pricing contract), T6 (facade/adapter boundary), T10 (exit-criterion evidence). Any deviation from D10 (type relocation) or D13 (no silent mock fallback) escalates immediately.

### S2 — M2 Correlation Complete (PRD Phase 2)
- milestone: M2 — Correlation Complete
- type: dev
- status: not started
- dependencies: S1

The correlation wedge becomes real beyond a single instrumented app: the `obstack-collector` distro ships as config-only OTel Collector (container + DaemonSet), logs arriving without trace context join on (namespace/pod/container) + time window and render as visually distinct "nearby" entries in the LogsRail, thin `obstack-py` / `obstack-js` SDKs land with OpenAI/Anthropic/Vercel-AI auto-instrumentation and `@trace_agent` / `traceAgent` decorators over the standard OTel SDKs, and real search runs over `trace_summaries` with filters, free-text, and workspace-persisted saved views. Per coverage amendment 4 (clarification, not inflation — this was already PRD v1 scope, now named), the **LogsExplorer surface runs on real `logs`-table search with saved views** and is part of the M2 exit, not a later phase. Collector-originated spans populate the `infra` layer reserved in D8, and GenAI-event-based prompt/completion capture is added into the same D7 columns. **Exit:** the demo app running on K8s (kind cluster in CI) shows API→agent→LLM spans with correlated pod logs — solid and nearby — in one view, **and the LogsExplorer surface searches real logs with saved views persisted**. Expected to exceed one team run; splits into sequential sprints (collector+log-join, SDKs, trace search + LogsExplorer) at planning time, each landing on a working product.

### S3 — M3 Product Shell (PRD Phase 3)
- milestone: M3 — Product Shell
- type: dev
- status: not started
- dependencies: S2

Postgres arrives beside the telemetry flow and obstack becomes a product a stranger can use: auth, orgs/workspaces, invites, DB-backed API keys (identical wire format to the M1 dev keys — only the lookup moves env→Postgres), usage metering and Stripe billing, quota-exceeded degrading to sampled ingestion with a banner rather than a hard cut, the onboarding "waiting for data…" screen that flips to the user's first real trace, a functional Connections hub (OTLP/Docker/K8s/Vercel/CloudWatch) showing live source health from ingest counters, the `explain` server function (Claude via API in cloud, configurable model self-hosted — this is also when the Explain button on the trace detail stops being inert), the per-workspace ingest-error counter surfaced in the UI, and per-workspace pricing overrides using the D9 JSON row shape. Per coverage amendment 5 (naming only), the **settings** surface (workspace / API keys / invites / billing UI) and the **onboarding** surface are named M3 shell deliverables, as is making the landing-page signup CTA live. **Exit:** a stranger signs up, connects a source, and reaches a correlated trace unassisted. Expected to exceed one team run; splits into sequential sprints (identity+keys+settings, metering+billing, onboarding+connections, explain) at planning time.

### S4 — M4 Launch Hardening, build (PRD Phase 4)
- milestone: M4 — Launch Hardening
- type: dev
- status: not started
- dependencies: S3

The same-images constraint is discharged and the product becomes distributable: `web` is containerized as a Next standalone image, the full self-hosted bundle ships as a compose profile plus a Helm chart built from **the same images**, retention-tier TTL enforcement lands on the D7 tables, and the docs site and public demo environment are built. Per coverage amendment 6 (naming only), the **in-app docs** surface (same content source as the docs site), **`/status`** (external uptime monitor plus manually curated incident notices — no bespoke status backend), **`/changelog`** (static, release-note driven, part of the docs pipeline), and the final launch pass on the **landing page** are named M4 deliverables. **Exit (build half):** a clean checkout produces the web + ingest images, the compose profile and Helm chart both boot the full stack from those images with tier TTLs applied, and docs/status/changelog content builds. Deployment work is not in this sprint — S4 hands off to S5.

### S5 — M4 Launch Hardening, ship
- milestone: M4 — Launch Hardening
- type: deploy
- status: not started
- dependencies: S4

Handed to deploy-team, not dev-team. Ships the public demo environment, the docs site (plus `/status` monitoring and `/changelog` per amendment 6), and the cloud SaaS environment from the S4 images, then runs design-partner onboarding against them. Environment: production (plus a staging/demo environment for the public demo). **The hosting/registry/DNS provider — and the external uptime monitor behind `/status` — is the user's decision; this plan does not choose one.** **Exit:** first 5 design partners activated on the deployed environment; public launch.

### S6 — M5 Deep Telemetry (post-v1)
- milestone: M5 — Deep Telemetry
- type: dev
- status: not started
- dependencies: S3

The metrics signal arrives end-to-end and the analysis surfaces stop being demos: OTLP metrics ingestion (receiver, ClickHouse tables, derived-metric rollups) lands in the same ingest binary, and on top of it the **explore** chart builder, **dashboards** (with workspace-store persistence moving to Postgres), **infra** views (nodes/pods/rightsizing), the **service map** derived from span parent/child topology, **services** catalog and scorecards derived from summaries plus metrics, **costs** analytics and recommendations (the v1 cost story stays on the M1 overview), **users** impacted-user analytics (`enduser.id` already flows through the D7 attribute Maps from M1 — no schema change needed), **traces/diff** as a pure query-layer feature over `spans`, and the overview's WatchWidgets finally leaving mock. Closes coverage amendment 2: metrics ingestion had no owner post-v1 before this bucket existed. **Exit:** to be set at M5 planning; detailed sprint sequencing is decided at that planning moment per D20's shippable-increment seam constraint.

### S7 — M6 Ops Suite (post-v1)
- milestone: M6 — Ops Suite
- type: dev
- status: not started
- dependencies: S6

obstack gains the ability to act on what it observes: alert rule evaluation (scheduled ClickHouse queries) plus a notifier component delivering notifications, **SLOs** with burn-rate computed by scheduled queries over summaries and metrics, **on-call** rotations/escalations/channels riding that same notifier, **incidents** as objects with timelines in Postgres (RCA reusing Explain), **issues** as error grouping over spans and logs, and **changes** tracking fed by deploy/flag event sources (GitHub Actions and deploy connectors, catalog-gated in the PRD). Closes coverage amendment 1: nothing in M1–M4 ever built an alert-evaluation/notification engine, so alerts/oncall/slos/incidents/issues were silently unowned. The **security** surface may be pulled forward into this bucket by enterprise demand — that call is made at M6 planning and never moves into v1. **Exit:** to be set at M6 planning; detailed sprint sequencing is decided at that planning moment per D20's shippable-increment seam constraint.

### S8 — M7 Intelligence & Governance (post-v1)
- milestone: M7 — Intelligence & Governance
- type: dev
- status: not started
- dependencies: S7

The layer above the data: **Ask** (natural-language querying, explicitly out of PRD v1), **evals** (explicitly out of PRD v1), **security** — ingest-time redaction rules plus audit events, **mcp** — a net-new MCP server component over the query layer, and **pipelines** for telemetry routing and pipeline management. SSO/SAML and SOC2, the PRD's named fast-follow, also land here. Closes coverage amendment 3: the MCP server and the redaction pipeline are net-new components no prior milestone mentioned. **Exit:** to be set at M7 planning; detailed sprint sequencing is decided at that planning moment per D20's shippable-increment seam constraint.

## Run status

- S1 — M1 Core Pipeline: COMPLETE (2026-08-15) — 20/20 tasks approved (T1–T12 + fix tasks F1–F8), advisor signed the exit criterion, integrator GO. Smoke green from clean volumes; real trace renders in TraceExplorer (screenshot on file). Carry-forward gate items recorded in the team plan's escalations log (M2: cardinality cap, prices as-of, GenAI event form, pagination, search desync; M3: real org/identity/notifications, billing, dup-exposure revisit; M4: build-vs-runtime mode seam, Writer.Close bound).
- S2 — M2 Correlation Complete: not started
- S3 — M3 Product Shell: not started
- S4 — M4 Launch Hardening (build): not started
- S5 — M4 Launch Hardening (deploy): not started
- S6 — M5 Deep Telemetry: not started
- S7 — M6 Ops Suite: not started
- S8 — M7 Intelligence & Governance: not started

## Coverage check (2026-08-15)

- Every milestone → ≥1 sprint: M1→S1, M2→S2, M3→S3, M4→S4+S5; post-audit M5→S6, M6→S7, M7→S8. PASS.
- Every product surface → an owning milestone: the 29-row table in the coverage-map appendix assigns all of them. PASS (advisor-ruled).
- Every M1 acceptance criterion (A1–A10 done-checks) → a task: A1–A10 map 1:1 to S1.1–S1.10 / T1–T10 in the team plan, each carrying the founding doc's done-check verbatim in intent. PASS.
- Every deployment impact → a deploy sprint: only M4 carries deployment impact (M1 is local compose + `next dev`; M2 uses a CI kind cluster; M3's exit is product-functional). M4 → S5 (type: deploy). PASS.
- Gaps recorded honestly:
  1. M2/M3 are single sprints at this altitude but each clearly exceeds one team run; they must be split into sequential sprints before they are dispatched. Not yet done — noted, not hidden.
  2. M1's exit criterion includes a manual browser verification + PR screenshot (A10) that no script can assert; the smoke script covers only the facade assertion path.
  3. Whether M3's cloud environment stands up before M4 (i.e., whether S3 needs its own deploy sprint) is not derivable from the founding doc — see Questions.

## Questions

1. **Smoke-script entry point for the web facade.** RESOLVED (advisor D17, 2026-08-15): `smoke.sh` runs `npx tsx --conditions react-server deploy/compose/smoke.ts`, which sets `OBSTACK_DATA_MODE=live` and calls `listTraces`/`getTrace` from `src/server/data.ts` directly — real facade+adapter code path, no throwaway API route, no running Next server. Browser render stays a manual T10 check with screenshot.
2. **M3 environment.** OPEN (user decision at M3 planning): the M3 exit ("a stranger signs up… unassisted") implies a reachable hosted environment, but the founding doc places all deployment in M4. Does M3 need its own deploy sprint, or is the M3 exit demonstrated locally with deployment deferred to S5?
3. **M4 provider choice.** OPEN (user decision): hosting/registry/DNS for the cloud SaaS, docs site, and public demo remain unspecified — S5 cannot be sequenced into concrete tasks until they are named.
4. **M2/M3 sprint splits.** RESOLVED as deferred (advisor D20, 2026-08-15): splits are decided at each phase's planning moment (PRD §13 mandates per-phase plans), under the fixed seam constraint that every split ends in a shippable, demoable increment. Presumptive seams — M2a = collector distro + nearby log joins + real search (demoable via bring-your-own-OTel); M2b = SDKs + auto-instrumentation; M3a = auth/workspaces/DB-backed keys + onboarding; M3b = billing/metering + Connections hub + Explain. Each phase plan returns to the advisor before task breakdown begins from these seams.

## Coverage map (advisor-ruled appendix, 2026-08-15)

BINDING. Source: advisor platform-coverage audit (user directive: milestones must cover ALL aspects of the platform). Reproduced here in substance; the advisor's message is the authority.

### New post-v1 buckets (anchored to PRD §5 out-of-scope + §15)

- **M5 — Deep Telemetry**: OTLP metrics ingestion + derived-metric rollups in ClickHouse, explore/dashboards on real queries, infra views, service map/catalog from span topology, cost analytics, trace diff.
- **M6 — Ops Suite**: alert rule evaluation + notification delivery, SLOs, on-call, incidents, issue grouping, change tracking (via GitHub Actions/deploy connectors).
- **M7 — Intelligence & Governance**: Ask (NL querying), evals, security/redaction, MCP server, telemetry pipelines. SSO/SOC2 (PRD fast-follow) also lands here.

### Surface → owner table (29 surfaces)

| Surface | Owner | Note |
|---|---|---|
| overview | **M1** (T8) | Trace-derived stats/charts only; WatchWidgets stay mock until M5 |
| traces + traces/[id] | **M1** (T7) | Hero path; Explain button inert until M3 |
| traces/diff | M5 | Pure query-layer feature over `spans`; demo-only until then |
| logs | **M2** | PRD §5 "trace/log search" is v1 — LogsExplorer wires to `logs` table + saved views in M2 |
| explore | M5 | Chart builder needs derived metrics; demo-only until M5 |
| dashboards | M5 | Not in PRD v1 scope; workspace-store persistence moves to Postgres in M5 |
| connections | **M3** | Functional connectors + live source health from ingest counters (PRD v1) |
| onboarding | **M3** | Waiting-for-data flow, quickstart with real API keys (PRD v1) |
| settings | **M3** | Workspace/keys/invites/billing UI = the M3 product shell |
| ask | M7 | NL querying explicitly out of v1 (PRD §5) |
| costs | M5 | v1 cost story lives on overview (M1); dedicated analytics + recs = M5 |
| infra | M5 | Nodes/pods/rightsizing require metrics ingestion — out of v1 |
| map | M5 | Service map derived from span parent/child topology |
| services (+ [id]) | M5 | Catalog/scorecards derived from summaries + metrics |
| users | M5 | Impacted-user analytics; `enduser.id` flows through attribute Maps from M1 — no schema change needed |
| alerts | M6 | Alerting explicitly out of v1 |
| oncall | M6 | Rotations/escalations/channels ride the M6 notifier |
| slos | M6 | Burn-rate = scheduled queries over summaries/metrics |
| incidents | M6 | Incident objects + timeline in Postgres; RCA reuses Explain |
| issues | M6 | Error grouping over spans/logs |
| changes | M6 | Needs deploy/flag event sources (CI connectors, catalog-gated in PRD) |
| evals | M7 | Explicitly out of v1 (PRD §5) |
| security | M7 | Ingest-time redaction rules + audit events; enterprise pull may advance it — decided at M6 planning, never into v1 |
| mcp | M7 | New component (MCP server over the query layer) |
| pipelines | M7 | Telemetry routing/pipeline management |
| docs (in-app) | **M4** | Same content source as the M4 docs site |
| / (landing) | **M4** | Exists; M3 makes signup CTA live, M4 finalizes for launch |
| /status | **M4** | External uptime monitor + manually curated incident notices; no bespoke status backend |
| /changelog | **M4** | Static, release-note driven; part of docs pipeline |

### Amendments

1. **Gap closed by defining M6**: nothing in M1–M4 ever built an alert-evaluation/notification engine — the alerts/oncall/slos/incidents/issues surfaces were silently unowned. M6 owns it (scheduled ClickHouse queries + a notifier component; design at M6 planning).
2. **Gap closed by M5**: metrics ingestion (infra/explore/dashboards prerequisites) had no owner post-v1. M5 owns the metrics signal end-to-end (ingest receiver, CH tables, rollups).
3. **Gap closed by M7**: MCP server and redaction pipeline are net-new components no prior milestone mentioned.
4. **M2 amendment (clarification, not inflation)**: M2 exit explicitly includes the LogsExplorer surface running on real `logs` search + saved views — this was already PRD v1 scope, now named.
5. **M3 amendment (naming only)**: settings + onboarding surfaces are the M3 shell deliverables.
6. **M4 amendment (naming only)**: in-app docs, /status, /changelog are M4 deliverables per the table.
7. **M1 unchanged.** No new work enters v1; no PRD-excluded feature moves earlier.
8. **Live-mode ruling (affects T7/T8 and all future wiring)**: in `OBSTACK_DATA_MODE=live`, unwired surfaces **keep rendering mock content with a persistent "SAMPLE DATA — preview" badge**; wired surfaces render real data with real empty states and never fall back to mock. Mechanism: a single const registry of live-wired route prefixes in `src/server/data.ts`; the app shell layout renders the badge for unregistered routes when mode=live. Rationale: empty-gutting 20 surfaces would destroy demo value, but a live customer must never mistake fiction for their data — one registry keeps every future wiring task a one-line flip. Carried into the M1 team plan as **D21** and task **T12**.

### PM note on the appendix (flag, not a fix)

Amendment 7 declares "M1 unchanged / no new work enters v1", but ruling 8's badge mechanism is itself new M1 work — it lands in the M1 team plan as D21 + T12 (registry in `src/server/data.ts` established by T6, badge rendered by T12). Recorded as an inconsistency in the advisor's own ruling, not resolved here. Ruling 8 is the later and more specific statement, so it is the one applied.

## Run log

- 2026-08-15 — plan created from advisor founding doc + execution PRD; S1 written in full task detail, S2–S5 outlined. No sprint run yet.
- 2026-08-15 — advisor platform-coverage audit applied: M5/M6/M7 buckets defined (S6–S8 outlined), 29-surface owner table and amendments 1–8 recorded as a binding appendix, M2/M3/M4 paragraphs amended per amendments 4/5/6. No new work entered v1 except ruling 8's badge mechanism (M1 team plan: D21 + T12).
- 2026-08-15 — advisor rulings D17–D20 applied: smoke via tsx facade harness; pricing split out of T4 into T11 (wave 3); T9 done-check scoped to the ingest boundary with the row-level assertion moved to T10; M2/M3 splits deferred with presumptive seams. S1 team plan is now T1–T11 across 7 waves, ready to dispatch.
- 2026-08-15 — S1 RUN COMPLETE (dispatched, interrupted mid-wave-4, resumed and finished same day). 20/20 tasks approved incl. 8 advisor-ordered fix tasks; rulings D21–D27 + amendments recorded in the final team plan (archived at `.planning/2026-08-15-s1-team-plan-final.md`, exit evidence at `.planning/2026-08-15-s1-exit-evidence.png`). Exit criterion advisor-signed; integrator GO after one fix round (F8). Next: S2 (M2 Correlation Complete) planning per D20's presumptive seams.
