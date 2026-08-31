# S6 — M5 Deep Telemetry — Phase Plan (sprint altitude), with the M5–M7 full-platform frame

meta:
- date: 2026-08-31
- repo/branch: `master` @ `11b6e9b` (clean tree)
- trigger: user directive 2026-08-31 — "complete the full platform", scope confirmed **everything (A+B+C)**: all remaining sample-data surfaces wired to real data across M5, M6, M7. S5 exit items (U13 partner activation, U14 Polar verification, real-money checkout, K6 price) run **in parallel** and do not gate this plan (user-selected).
- source of truth: `.planning/2026-08-15-obstack-backend-build-vision.md` (S6/S7/S8 buckets lines 72–95, surface→owner table lines 141–176, amendments 1–3, D21/D32) + `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md` §5 (v1 exclusions stay excluded from v1 — this plan is post-v1 by construction) + two fresh audits (2026-08-31, this session): the data-foundation audit and the per-surface mock inventory (§2, §3 below carry their citations)
- owner: manager (plan only — no implementation, no task breakdown)
- process constraint (advisor D20): **this plan returns to the advisor BEFORE task breakdown.** No T-numbers, no waves, no file ownership. Sprint IDs are provisional until ruled.
- predecessor: **S5 — M4 ship — effectively closed on the technical legs** (production live on Railway under obstack.dev; billing rail proven on the 100%-discount walk; status.obstack.dev live). Formal S5 exit awaits the user-gated items named above; per the user's ruling they proceed in parallel.

---

## 1. FINAL GOAL VISION — the full platform (M5 → M7)

The platform is complete when no `/app` surface renders a SAMPLE badge in live mode: every route in `apps/web/src/lib/live-routes.ts` is either live-wired or product chrome, and the fixture modules in `apps/web/src/mock/` feed only the public demo. Concretely, in dependency order:

- **M5 Deep Telemetry (S6):** the metrics signal arrives end-to-end — OTLP metrics ingestion in the same ingest binary, ClickHouse metrics tables + rollups, and a metrics query API — and on top of it the analysis surfaces stop being demos: **explore** (chart builder), **dashboards** (workspace-persisted), **infra** (nodes/pods/right-sizing via the collector), **map** (span-topology-derived), **services** (catalog + scorecards), **costs** (unit economics), **users** (impacted-user analytics), **traces/diff**, and the overview's **WatchWidgets** leave mock.
- **M6 Ops Suite (S7):** obstack acts on what it observes — an alert-rule evaluation engine (scheduled ClickHouse queries) plus a notifier component, then **alerts**, **slos** (burn rate over summaries + metrics), **issues** (error grouping), **incidents** (Postgres objects + cross-surface timeline, RCA reusing Explain), **oncall** (rotations/escalations riding the notifier), **changes** (deploy/flag event connectors).
- **M7 Intelligence & Governance (S8):** the layer above the data — **ask** (NL querying over everything the earlier milestones made real), **evals** (replay/regression harness), **security** (ingest-time redaction + runtime detections), **mcp** (net-new MCP server over the query layer), **pipelines** (telemetry routing), SSO/SAML + SOC2 fast-follow.

Exit (whole arc): a signed-up workspace ingesting real telemetry sees **zero SAMPLE badges** — every surface renders that workspace's data or an honest real empty state (D21's registry emptied of unregistered routes), and the honesty rules (D13/D21) hold on every new surface from its first commit.

---

## 2. Foundation facts — what exists today (audited 2026-08-31)

**ClickHouse (database `obstack`):** exactly four objects — `spans` (MergeTree, `ORDER BY (workspace_id, trace_id, span_id)`), `logs` (MergeTree, bloom filter on `k8s_pod`), `trace_summaries` (AggregatingMergeTree) and its MV `trace_summaries_mv` (`services/ingest/migrations/0001–0004`). **No metrics table, no other rollups.**

**Postgres:** tenant/auth/billing shell complete — `workspaces`, `saved_views`, better-auth's 7 tables, `api_keys`, `usage_ledger`, `api_key_health(+_windows)`, `pricing_overrides`, `plans`, `workspace_plans`, `explain_runs` (`services/ingest/pgmigrations/0001–0007`). **No dashboards, alert-rules, SLO, incident, on-call, or catalog storage.**

**OTLP:** traces and logs accepted (gRPC + HTTP, `services/ingest/internal/receive/grpc.go:33-34`, `http.go:57,64`; Vercel + CloudWatch drains reuse the log path). **Metrics: not accepted, not stored, not queried** — no `pmetricotlp` registration anywhere.

**Wiring pattern (the finish line per surface):** `connections` is the reference — server component branches on `dataMode`, live mode reads a real query module, mock fixture is demo-only (`apps/web/src/app/app/connections/page.tsx:36-85`); flipping a surface live is one line in `apps/web/src/lib/live-routes.ts` + the badge disappears via `SampleDataBadge.tsx`. Every wiring sprint ends on that flip.

**Missing foundations, named (each is real new DDL/receivers/services, not query modules):** metrics ingestion + storage; k8s/infra inventory (only span/log resource attrs exist today); alerting/incident/on-call state; SLO definitions + burn tracking; dashboards persistence; deploy/pipeline/change tracking; security findings + redaction rules; MCP server; eval harness.

---

## 3. Per-surface sizing (audit, 2026-08-31) and vision-doc ownership

| Surface | Vision owner | Real source | Size | Note |
|---|---|---|---|---|
| explore | M5 | new metrics store + query API | **XL** | THE M5 foundation; dashboards blocks on it |
| dashboards | M5 | Postgres CRUD + explore's API | L | widget data rides explore |
| infra | M5 | k8s collector metrics | L | needs the obstack-collector metrics leg |
| map | M5 | trace-derived (span topology) | M | today hardcoded SVG in `components/map/ServiceMap.tsx` — not even a fixture |
| services | M5 | trace-derived + registry; deploys feed is M6's | L | scope-fence v1 to trace-derived (see §5 fences) |
| costs | M5 | trace LLM cost + cloud billing + revenue | **XL as mocked** | fence v1 to trace-derived LLM economics (§5) |
| users | M5 | trace-derived (`enduser.id` already in attr Maps) | **M** | pure aggregate query |
| traces/diff | M5 | trace-derived | S | pure query layer |
| WatchWidgets | M5 | metrics + trace aggregates | S | rides explore's API |
| alerts | M6 | new rules engine + notifier | **XL** | THE M6 foundation |
| slos | M6 | defs store + scheduled burn queries | L | rides metrics + scheduler |
| issues | M6 | trace-derived error grouping | **M** | **pull-forward candidate → M5** (no notifier dependency; audit sized it a pure aggregation) |
| incidents | M6 | timeline stitching + RCA via Explain | L | blocked on alerts/changes being real |
| oncall | M6 | scheduler subsystem OR pager integration | **XL if built** | build-vs-integrate is an advisor/user ruling (§5) |
| changes | M6 | CI/git/k8s/flag connectors fan-in | XL | one real deploys feed unblocks services + evals + incidents too |
| ask | M7 | AI agent over the real query layer | XL | capstone; sequence last |
| evals | M7 | replay harness + git metadata | XL | |
| security | M7 | redaction rules + live detections | XL | vision: may pull into M6 on enterprise demand — decided at M6 planning |
| mcp | M7 | net-new MCP server component | XL | page itself says "NOT BUILT YET" |
| pipelines | M7 | new registry + run-history ingest path | L | |
| connections | M3 | — | **done** | already live-wired; excluded |

---

## 4. Calibration — unchanged through S5

The reading that has held for fourteen closed runs: **one coherent area per dev-team run, 4–16 task-slots; every multi-area batch on record needed fix waves (S1) or was split by ruling (D28, D94, S4 option C).** S5 (deploy-team) confirmed the same shape on ship work. Nothing in the record licenses batching, and M5–M7 contain at least six subsystem-class builds (metrics store, alert engine, on-call, changes fan-in, security, MCP/ask) — each is its own run at minimum.

---

## 5. M5 sprint-level split — options (advisor-owned; IDs provisional)

**Common exit (M5, proposed):** explore, dashboards, infra, map, services, costs, users, traces/diff and WatchWidgets render the signed-in workspace's real data in live mode (each flipped in `live-routes.ts`), the OTLP metrics signal is ingested/stored/queryable end-to-end, and the public demo is byte-unchanged in mock mode (D114/D21).

**Scope fences proposed for the whole milestone (need advisor + user sign-off):**
- **costs v1 = trace-derived LLM unit economics only.** The mocked infra-$ split and per-customer revenue margin require cloud-billing and Stripe/Polar-revenue integrations — catalog-gated, deferred to a later run or M6's connector machinery. The surface ships honest about what it computes.
- **services v1 = trace-derived catalog + scorecards.** The "recent deploys" panel stays SAMPLE-labeled (or hidden) until M6's changes feed exists — one real deploys feed later unblocks services, evals, and incidents at once.
- **issues pull-forward:** vision assigns issues to M6, but it is a pure trace-derived aggregation (M-sized, no notifier dependency). PM proposes pulling it into M5's query pack. Advisor ruling requested.
- **infra depends on a collector metrics leg:** the config-only obstack-collector distro (M2) must start shipping k8s metrics (kubeletstats/kube-state shape) — this is receiver + collector-config work inside S6.1/S6.4, not a new component.

### Option A — M5 as one run
All nine surfaces + the metrics subsystem in one dev-team run. **> S1 by any measure. Listed for completeness; the calibration evidence rejects it.**

### Option B — two sprints: foundation, then all surfaces
- S6.B1 — metrics subsystem + explore.
- S6.B2 — the other eight surfaces.
- B2 batches persistence-CRUD, k8s collection, and five query surfaces — the S1 shape again.

### Option C — PM recommendation: four sequential sprints

#### S6.1 — the metrics signal + explore (foundation)
- **run-goal:** obstack M5 sprint 1 — metrics end-to-end (exit: OTLP metrics accepted on gRPC + HTTP in the same ingest binary, stored in workspace-scoped ClickHouse tables with rollups sized for the explore query shapes, a metrics query API serves the metric-catalog/group-by/range contract `mock/explore.ts` implies, and the explore surface renders real charts in live mode — flipped in `live-routes.ts` — while mock mode stays byte-identical).
- **scope fence:** no dashboards persistence, no k8s collector changes beyond what proving ingestion needs, no other surface flips. Metric catalog v1 = what real SDK/collector traffic actually emits, not the fixture's full 15 — honesty over parity.
- **demoable as:** "point the SDK at your workspace, chart your own tokens/min in explore."
- **size note:** one subsystem + one surface ≈ S3.1's class (16 slots, the known ceiling). The DDL design (cardinality, rollup grain) is the risk; advisor packet needed on schema before breakdown.

#### S6.2 — the trace-derived query pack: map, services, users, traces/diff (+ issues if pulled forward)
- **run-goal:** obstack M5 sprint 2 — the trace-derived surfaces (exit: map renders the workspace's real span-topology with live edge rates, services renders a real catalog/scorecards derived from summaries, users renders real impacted-user aggregates from trace attributes, traces/diff compares two real traces; each flipped in `live-routes.ts` with real empty states).
- **scope fence:** query modules + UI wiring over EXISTING tables only — any need for new DDL escalates rather than lands. Services' deploys panel per the milestone fence. No metrics dependency (runs against spans/summaries), so this sprint is parallelizable with S6.1 if the advisor rules the team can run two dev-team runs — the PM default is sequential.
- **demoable as:** "your architecture draws itself from your traces."
- **size note:** four-to-five S/M items, one coherent shape (read-only aggregations) ≈ S3.2's class.

#### S6.3 — dashboards + WatchWidgets (persistence on the metrics API)
- **run-goal:** obstack M5 sprint 3 — dashboards for real (exit: dashboards/widgets CRUD persists per-workspace in Postgres, widget charts render from S6.1's query API, the overview's WatchWidgets read real data, both flipped in `live-routes.ts`).
- **scope fence:** persistence follows the `saved_views` pattern; no sharing/ACL beyond workspace scope; no new chart types beyond the four mocked.
- **demoable as:** "build a dashboard, reload, it's yours and it's real."

#### S6.4 — infra + costs (the collector leg + fenced economics)
- **run-goal:** obstack M5 sprint 4 — infra views and unit economics (exit: the collector distro ships k8s metrics into the S6.1 store, infra renders real node/pod views for a workspace running the collector — right-sizing recs fenced to what real data supports — and costs renders trace-derived LLM economics honestly labeled; both flipped).
- **scope fence:** the §5 costs fence verbatim; right-sizing $ figures only where a real price input exists, else the column is honestly absent (D13).
- **demoable as:** "your cluster and your LLM spend, real."

| dimension | A | B | C (rec) |
|---|---|---|---|
| largest sprint vs calibration | > S1 | B2 > S1 | ≈ S3.1 class max |
| areas batched | all | B2: 3+ | none |
| overrun blast radius | everything | all surfaces | one sprint |
| advisor rounds | 1 | 2 | 4 |

---

## 6. M6 / M7 — frame only (detailed split at their own planning moments, per D20)

- **S7 (M6) sketch, dependency-ordered:** alert engine + notifier + alerts surface (foundation, XL) → slos → incidents → changes (the deploys feed; unblocks services' panel + evals later) → oncall. **Standing rulings needed at M6 planning:** oncall build-vs-integrate (audit: integration likely cheaper than building a scheduler subsystem); security pull-forward or not (vision reserves the call).
- **S8 (M7) sketch:** pipelines → security (redaction + detections) → mcp (net-new server) → evals → ask (capstone, last — it queries everything). SSO/SOC2 ride alongside per PRD fast-follow.
- Each gets its own phase plan in this format when its predecessor closes.

---

## 7. Standing constraints binding every sprint above

- D21/D114: mock mode stays byte-identical; live surfaces never fall back to mock; the `live-routes.ts` flip is each surface's exit.
- D13 honesty: no fabricated numbers — fenced-out data is absent, not invented.
- D7/D11 tenancy: every new ClickHouse table is `workspace_id`-first and read only through `forWorkspace`-style scoping; proven red per table.
- Deployment impact: new ingest capabilities (metrics receivers, collector config) ride the existing images/compose/chart/Railway rails — any deploy-shaped work goes to a deploy sprint, not a dev sprint.
- CI: the every-PR check set grows in place (no renames, K3).

## 8. Open decisions — RULED (advisor, 2026-08-31, pre-breakdown gate)

All five decided; plan **APPROVED for S6.1 task breakdown** under D360–D365 and the §9 conditions. Claims verified against the tree at `11b6e9b` before ruling.

1. **D360 — split = Option C, BINDING.** S6.1 → S6.2 → S6.3 → S6.4, IDs final. Fourteen closed runs say one coherent area per run; C's largest sprint (S6.1) sits at the S3.1 class ceiling.
2. **D361 — issues pull-forward YES, into S6.2, with a statelessness fence.** v1 issues is pure derived aggregation: fingerprint computed at query time over `spans`/`logs`; the `status` field derived from recency windows (new/ongoing/resolved), never persisted. No Postgres issue table, no assign/mute/resolve — that lifecycle is M6's. If an honest surface proves impossible without persisted state, the task escalates and issues returns to M6; it does not land DDL under S6.2's fence.
3. **D362 — costs and services fences ACCEPTED, one amendment.** Costs: fenced-out figures are absent, not zeroed or estimated (D13), verbatim. Services: the deploys panel stays rendered with a per-section `SampleMark` (D106 settings precedent) — not hidden; the mark comes off when M6's changes feed lands.
4. **D363 — metrics DDL design review REQUIRED as a pre-breakdown advisor packet; the DDL task is a critical item regardless (S1 T2/D7 precedent; cardinality is the S1 carry-forward risk on record).** Breakdown may start in parallel with the packet, but no DDL task dispatches before the packet is ruled. Packet question families (verbatim in the advisor report): Q1 schema shape (wide vs per-temperament tables, histogram representation, Map vs materialized attrs, metric-identity key, `workspace_id`-first ORDER BY/partitioning, temporality normalization, exemplars presumed out); Q2 cardinality bounds (per-workspace active-series cap as a number, D6 drop+counter enforcement, attr limits, honest-UI breach behavior, cheap per-batch measurement); Q3 rollup grain (raw → 1m → 1h chosen backwards from `mock/explore.ts`'s `ExploreQuery`×`GroupBy` contract, AMT+MV house pattern vs alternatives, MV insert-amplification cost); Q4 TTL/tiering (per-grain TTLs, extend `0004_retention_outer_ttl` in place, plan-tier interaction, D365 recorded in the packet). The packet also freezes the query-API contract from `mock/explore.ts` before DDL.
5. **D364 — parallel dispatch DENIED; sequential-only.** No precedent for concurrent dev-team runs; hard shared-file coupling (`live-routes.ts`, query-layer tree, `e2e`); single-threaded advisor pipeline. S6.1 first — it is the milestone's critical path.

**D365 (supplementary) — metrics do not meter in v1.** D99's per-trace head-sampling quota model does not fit data points; the abuse guard is the Q2 series/cardinality cap plus accepted/dropped counters in the existing `api_key_health` shape. Billing metrics volume is a pricing decision, pre-registered USER-VISIBLE for a later billing revisit — never lands silently in a dev sprint.

**Structural flags (recorded, not redesigned):**
- S6.4 seam pre-registered: if the collector metrics leg balloons at breakdown, **costs splits out as S6.5** (zero dependency on the collector leg) rather than triggering a fix wave.
- **S6.1 deploy touchpoint named now:** production ClickHouse migration + Railway ingest redeploy is a pre-registered deploy step at S6.1 close (inside the exit's evidence plan, outside the dev sprint's scope). The S5 volume-wipe incident is the cautionary precedent.
- M6 planning flag: consider pulling `changes` to second in S7 (three consumers block on it; no alert-engine dependency). Oncall presumption to beat at M6 planning: integrate a pager provider over building a scheduler subsystem.

## 9. Conditions attached to S6.1's run-goal (advisor, binding at breakdown)

1. D363 gate: no DDL task before the packet is ruled; the DDL task is a critical item returning to the advisor before merge.
2. Contract-first: the metrics query API contract is frozen from `mock/explore.ts` at kickoff; catalog v1 = what real traffic emits (fewer than the fixture's 15 metrics is correct, not a gap).
3. Tenancy proven red per new object — every metrics table AND every rollup MV target is `workspace_id`-first, readable only through `forWorkspace` scoping, unscoped-SQL tripwire proven red against each (D7/D11 made explicit for MVs).
4. D365 applied: accepted/dropped counters in the existing health shape; no metering code in S6.1.
5. Deploy pre-registration per the structural flag above.
6. Standing D21/D114 clause as written: mock mode byte-identical; the `live-routes.ts` flip is the exit; live never falls back to mock.
