# S2 — M2 Correlation Complete — Phase Plan (sprint altitude)

meta:
- date: 2026-08-16
- repo/branch: `master` @ `6108abc`. (PM noted a stale session-start snapshot showing `ingest-migrations-single-runner` @ `0f84d69`; resolved 2026-08-16 — the working tree is the merged `master`, verified by the orchestrator: `git status` clean on `master`, HEAD `6108abc`, both PRs merged.)
- source of truth: `.planning/2026-08-15-obstack-backend-build-vision.md` (S2 paragraph, D20, amendments 1–8, coverage map) + `.planning/2026-08-15-s1-team-plan-final.md` (D1–D27, escalations log, goal check) + `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md` §5/§7/§8/§13/§15
- owner: project manager (plan only — no implementation, no task breakdown)
- process constraint (advisor D20): **this plan returns to the advisor BEFORE task breakdown.** No T-numbers, no waves, no file ownership in this document — by design.
- predecessor: S1 / M1 **CLOSED** (2026-08-16). Two post-GO PRs on master: #3 span-layer vocabulary contract tests, #4 `ingest migrate` + `OBSTACK_MIGRATE_ON_BOOT`. Exit re-verified from clean volumes.

---

## 1. FINAL GOAL VISION — M2

M2 is done when the correlation wedge survives contact with a real cluster and a second instrumentation path: the `obstack-collector` distro (config-only OTel Collector, one container / one DaemonSet) tails container stdout and attaches pod metadata, the demo app running on Kubernetes renders as one trace whose API→agent→LLM waterfall sits beside its container logs — solid where a `trace_id` matches, visually distinct "nearby" where only (namespace/pod/container) + a time window matches — while the traces list and the LogsExplorer surface both search real ClickHouse data with filters, free text, honest totals and saved views a workspace keeps, and a team that would rather not touch OTel wiring gets the same trace from `obstack-py` / `obstack-js` with auto-instrumented OpenAI/Anthropic/Vercel-AI calls and one decorator on their agent step.

---

## 2. S2.0 — CI foundation + kind capability (user-decided precursor)

- id: **S2.0**
- milestone: M2 — Correlation Complete (precursor; enables the M2 exit criterion)
- type: dev
- status: planned (2026-08-16)
- dependencies: S1 (CLOSED)
- decided by: **the user, 2026-08-16** — not derived from the blueprint, not open for re-litigation. The advisor is asked only to confirm its boundary against the first M2 dev sprint (packet item 9).

**Why it exists (evidence, not assertion):**
- `.github/` does not exist in this repo — zero workflows, therefore zero status checks. PRs #3 and #4 merged unguarded; PR #3's own body states there is no CI running both suites today.
- Every M1 suite (`go test ./...`, `go vet`, `gofmt`, `npm test` 21/21, `npm run build`, `smoke.sh`) is verified **by hand** on demand. Nothing prevents an M2 PR from silently regressing them.
- M2's exit criterion as written requires "the demo app running on K8s (**kind cluster in CI**)". With no CI, the exit criterion is unsatisfiable as stated.

**run-goal (verbatim to dev-team):**
> obstack CI foundation — every pull request is guarded by the Go and web suites, and CI can stand up a kind cluster (exit: a PR shows green required checks for `go test ./...` + `go vet` + `gofmt` + `npm test` + `npm run build`, and a kind-cluster job boots a cluster and verifies a workload on it).

**exit criterion:** on a throwaway PR against `master`, GitHub Actions reports green checks for the Go suite (test, vet, gofmt), the web suite (`npm test`, `npm run build`), and a kind job that creates a cluster, loads a locally built image and asserts the workload reaches Ready — and a deliberately broken commit pushed to that PR turns the corresponding check red (the guard is proven by failure, not by green).

**scope fence:**
- CI capability only. **Deploying the obstack stack (ClickHouse + ingest + demo) onto kind is M2 dev-sprint work**, not S2.0 — S2.0 proves the cluster can be created and can run a locally built image (see packet item 9 for confirmation).
- No new product behaviour, no schema change, no dependency upgrades, no lint-baseline changes (M1's lint baseline is 7 pre-existing problems in unowned files — S2.0 must not "fix" them into scope).
- No deployment to any hosted environment. No provider choice is made here (that stays the user's decision at M4/S5).

**known trap this sprint must not fall into (grounded):** `services/ingest/internal/write/integration_test.go:65` and `internal/migrate/integration_test.go:53` call `t.Skipf` when no ClickHouse is reachable. A naive CI `go test ./...` is therefore **green while skipping the integration tests** — the guard would be weaker than it appears. The sprint's exit must make that visible (run ClickHouse as a service and set `OBSTACK_TEST_CLICKHOUSE_DSN` / `OBSTACK_TEST_CLICKHOUSE_READONLY_DSN`, or fail on unexpected skips) rather than accept a hollow check.

**independently demoable as:** open a PR, watch it get judged. This is a working-product increment for the builder, not for the customer — the only sprint in this phase for which that is true, and it is why the user placed it before the M2 dev work rather than inside it.

---

## 3. M2 sprint-level breakdown — BOTH split options

The split is **ADVISOR-OWNED** (packet item 1). Both options below satisfy D20's fixed constraint (every split ends in a shippable, demoable increment). Sprint IDs are provisional and are assigned for real once the advisor rules.

Common to both options — the sprint that owns the K8s/collector work also owns these, because they are the same code path:
- ingest gains GenAI **log-event** extraction (`gen_ai.input.messages` / `gen_ai.output.messages` → the existing D7 `prompt`/`completion` columns; additive, `internal/mapping` only) per the T9 M2-GATE ruling.
- the `infra` layer question (packet item 5) lands wherever the advisor rules — it is currently undefined in every source document.

### Option A — D20's presumptive seams (2 sprints)

#### S2.A1 — collector distro + nearby log joins + real search
- milestone: M2 · type: dev · dependencies: S2.0
- **run-goal (verbatim):** obstack M2a — collector distro, nearby log correlation and real trace+log search on Kubernetes (exit: the demo app on a kind cluster in CI renders API→agent→LLM with solid and nearby pod logs in one view, and LogsExplorer searches real logs with saved views persisted).
- **exit criterion:** the vision doc's full M2 exit line, met — kind cluster in CI runs ClickHouse + ingest + the `obstack-collector` DaemonSet + the demo app; the trace detail shows the four-layer waterfall with solid (`trace_id`) and nearby (pod/namespace/container + window) logs visually distinguished; `/app/traces` search runs on real filters with honest totals and pagination; `/app/logs` runs on the `logs` table with saved views that survive a reload; no SAMPLE badge remains on a wired surface and empty states are real (D13/D21).
- **scope fence:** no SDKs, no auto-instrumentation, no publishable packages. No Helm chart (M4) beyond whatever the kind deployment needs — see packet item 8. No Postgres unless the advisor rules it in for saved views (packet item 3). Surfaces outside `traces`, `traces/[id]`, `logs`, `overview` stay on mock + badge.
- **independently demoable as:** "point any OTel collector or SDK at obstack on your own cluster and search what comes back" — the complete bring-your-own-OTel product, which is the PRD's positioning line (§11) and does not need an obstack SDK to be true.
- **PM size note (evidence):** this bundles a net-new component (collector distro), a net-new deployment target (K8s + kind in CI), an ingest change (GenAI events, infra layer), a query-layer change (nearby join), two UI surfaces (traces search, LogsExplorer), a persistence decision, and two carry-forward search items. S1 — a comparable-but-narrower footprint — needed 20 tasks across 7 waves and one mid-run interruption. This is the option's central risk.

#### S2.A2 — SDKs + auto-instrumentation
- milestone: M2 · type: dev · dependencies: S2.A1
- **run-goal (verbatim):** obstack M2b — `obstack-py` and `obstack-js` SDKs with LLM auto-instrumentation and agent decorators (exit: an SDK-instrumented sample app produces the same four-layer trace with GenAI attributes through install + two lines of setup).
- **exit criterion:** a sample app instrumented only with the obstack SDK (no manual OTel wiring beyond the documented two lines) sends OpenAI/Anthropic/Vercel-AI calls and `@trace_agent` / `traceAgent` steps that land in ClickHouse with the D8 attributes and render as the same four-layer trace; the SDKs are thin over the standard OTel SDKs (standard OTLP on the wire, verifiable by pointing them at any OTLP endpoint); SDKs fail open — a broken endpoint never breaks the sample app (PRD §9).
- **scope fence:** no new ingest columns, no schema change — the SDKs must fit the D8 contract as it stands (span-attribute form for prompt/completion, per the T9 ruling). No connectors, no auth changes, no publishing to a public registry unless the advisor rules registry publication into M2.
- **independently demoable as:** "two lines and your agent shows up" — the activation story the PRD's onboarding target (§8, <30 min) is built on.

### Option B — the S2 paragraph's own wording (3 sprints)

#### S2.B1 — collector distro + log join on Kubernetes
- milestone: M2 · type: dev · dependencies: S2.0
- **run-goal (verbatim):** obstack M2 sprint 1 — `obstack-collector` distro and nearby log correlation on Kubernetes (exit: the demo app on a kind cluster in CI renders API→agent→LLM spans with solid and nearby pod logs in one view).
- **exit criterion:** kind cluster in CI runs ClickHouse + ingest + the collector (container form and DaemonSet form both exercised) + the demo app; one `POST /chat` on the cluster produces a trace whose detail view shows the four-layer waterfall plus its container logs, solid where `trace_id` matches and nearby where only (namespace/pod/container) + window matches, rendered visually distinct; GenAI log-event prompt/completion extraction lands in the same D7 columns.
- **scope fence:** search stays exactly as M1 shipped it (200-cap list, summary-level free text) — improving it is the next sprint. No SDKs. No LogsExplorer wiring. No saved-views work.
- **independently demoable as:** the PRD's Phase-2 exit sentence verbatim ("Demo app on K8s shows API→agent→LLM spans with correlated pod logs in one view") — the correlation wedge on real infrastructure, which is the demo the launch video is built from (PRD §11).
- **grounded note:** the nearby join needs no schema change. `obstack.logs` is `ORDER BY (workspace_id, trace_id, timestamp)` and trace-less logs carry `trace_id = ''`, so nearby candidates are a contiguous prefix range ordered by time, with `INDEX idx_pod k8s_pod TYPE bloom_filter` already in place for pod filtering (`services/ingest/migrations/0002_logs.sql:22,26`). The M1 trace-detail query reads logs by `trace_id` only (`src/server/queries/traces.ts:98-110`), so the nearby leg is a second query, not a rewrite.

#### S2.B2 — real trace + log search with persisted saved views
- milestone: M2 · type: dev · dependencies: S2.B1 (shares the query layer; sequential, not parallel)
- **run-goal (verbatim; AMENDED by D49 2026-08-16, citing D30 — was "workspace-persisted saved views"):** obstack M2 sprint 2 — real trace and log search on ClickHouse with persisted saved views (exit: the traces list and LogsExplorer both search real data with real totals, pagination and browser-persisted saved views (localStorage; workspace scoping lands with Postgres at M3)).
- **exit criterion (saved-views sentence AMENDED by D49, replaced with D30's user-signed wording):** `/app/traces` filters (service, status, duration, model, cost range, free text over prompts and logs, time range — PRD §8) run server-side with a real total and pagination instead of the 200-cap denominator; `/app/logs` renders from the `logs` table with severity/pod/free-text filters and its real empty state; saved views persist per browser (localStorage) and survive a reload — workspace-scoped saved views land with Postgres in M3 (PRD §6), pre-registered as an M3-gate item; `/app/logs` is registered in `src/lib/live-routes.ts` and carries no SAMPLE badge in live mode; mock mode unchanged.
- **scope fence:** no collector work, no K8s work, no SDKs. No new telemetry columns — search is a query-layer and UI concern over the D7 tables as they stand, plus at most an index/projection migration if free-text over log bodies demands one (pre-release, `down -v` precedent per D22/F5).
- **independently demoable as:** "find the trace you're looking for" — the surface that turns a pipeline into a tool; demoable on compose alone, no cluster required.
- **grounded note (parity gap this sprint closes):** live search today matches only `root_name`, `trace_id`, `models`, `services` (`src/server/queries/traces.ts:63-67`), while mock search also matches span names, prompts and log bodies (`src/server/data.ts:56-73`). Live search is therefore strictly weaker than the mock product it replaced, against PRD §8's "free-text over prompts/logs". Saved views are today a hardcoded 3-entry `const` in `src/components/traces/TracesSearch.tsx:11-15`.

#### S2.B3 — SDKs + auto-instrumentation
- milestone: M2 · type: dev · dependencies: S2.B1 (contract only; independent of S2.B2)
- **run-goal (verbatim):** obstack M2 sprint 3 — `obstack-py` and `obstack-js` SDKs with LLM auto-instrumentation and agent decorators (exit: an SDK-instrumented sample app produces the same four-layer trace with GenAI attributes through install + two lines of setup).
- **exit criterion / scope fence / demoable:** identical to S2.A2 above.
- **ordering sub-question:** the S2 paragraph lists SDKs second and search third. PM recommends SDKs **last** (see packet item 1) — it is the only sprint whose scope the M2 exit criterion does not require, so slipping it does not hold the milestone's exit hostage.

### Option comparison (what the code and the PRD actually say)

| dimension | Option A (2 sprints) | Option B (3 sprints) |
|---|---|---|
| largest sprint | S2.A1 = new component + new deploy target + ingest change + query change + 2 UI surfaces + persistence decision | S2.B1 (component + deploy target + one query leg) or S2.B2 (query layer + 2 UI surfaces) |
| seams in the query layer | one sprint owns `src/server/queries/*` end to end — fewest handoffs | nearby join (B1) and search (B2) touch the same directory in sequential runs — a documented handoff, not a conflict |
| exit criterion lands at | end of S2.A1 | end of S2.B2 |
| demo value per landing | 1 customer-facing landing before the milestone closes | 2 customer-facing landings before the milestone closes |
| risk if a run overruns | the whole M2 exit is inside one run | an overrun costs one third of the phase |
| restructure pressure (packet 6) | forced before S2.A2 | forced before S2.B3 (or wherever the SDK sprint is ordered) |

**PM recommendation (advisor-owned decision):** **Option B, reordered to B1 → B2 → SDKs last.** Rationale: Option A's first sprint is larger than S1, which is the only calibration data this project has, and S1 at that size needed 20 tasks, 7 waves, 8 advisor-ordered fix tasks and a mid-run interruption. Option B's seams each land on a product a customer could use, which is exactly D20's constraint. The cost of Option B is one extra advisor round and one query-layer handoff between sequential runs — cheap relative to a run that cannot land.

---

## 4. Carry-forward ledger (M2-gate items)

Every item below is from S1's escalations log or Goal-check ledger. "Owner" = the sprint that must close it under each option.

| # | item | source | Option A owner | Option B owner |
|---|---|---|---|---|
| 1 | 200-cap "N of M" denominator → real totals + pagination | T7 escalation, M2-GATE ("M2a search/pagination owns real totals"); code at `src/app/app/traces/page.tsx:43-51` | S2.A1 | S2.B2 |
| 2 | TracesSearch same-route filter desync (bar state seeded once at mount; a URL change from back/forward or a link does not re-sync the inputs — `src/components/traces/TracesSearch.tsx:57-71`) | T7 escalation, "deferred onto the M2 search ticket" | S2.A1 | S2.B2 |
| 3 | GenAI semconv drift: extract `gen_ai.input.messages` / `gen_ai.output.messages` from the log/event path into the same D7 `prompt`/`completion` columns — additive, `internal/mapping` only; span-attribute form stays the obstack-SDK convention | T9 escalation, advisor M2-GATE | S2.A1 | S2.B1 |
| 4 | The SDKs must emit the span-attribute prompt/completion form (D8 + D8-AMENDMENT: prompt/completion live only in the dedicated columns, never in the attributes Map) — documentation and conformance duty | T9 ruling, consequence for the SDK sprint | S2.A2 | S2.B3 |
| 5 | **CONTESTED** — unpriced-model counter label cardinality cap/allowlist (`obstack_ingest_unpriced_models_total{model}`, label is a client-controlled string) | T11 escalation says **M3-GATE**; Goal check iteration 0 lists it as **M2-gate** | S2.A1 *if M2* | S2.B1 *if M2* |
| 6 | **CONTESTED** — `prices.json` gains an `as_of` date + staleness story | same contradiction as #5 | S2.A1 *if M2* | S2.B1 *if M2* |
| 7 | Live/mock search parity: live free text does not reach span names, prompts or log bodies (PRD §8 requires prompts/logs) | PM-surfaced from the code + PRD; not previously logged | S2.A1 | S2.B2 |
| 8 | `/app/logs` must be registered in `src/lib/live-routes.ts` and lose its SAMPLE badge when wired; live empty states must be real (D13/D21) | D21 + amendment 4 | S2.A1 | S2.B2 |

**Explicitly NOT M2** (recorded so no sprint drifts into them): M3-gate — real org/identity/notifications replacing SAMPLE markers, billing surfaces, D23 dup-exposure revisit on design-partner evidence. M4-gate — badge/page build-vs-runtime mode seam, `Writer.Close` bound with Helm grace periods.

---

## 5. Advisor decision packet

Each item is a decidable question with options and consequences. Items 1–3 block task breakdown; the rest shape a single sprint and can be ruled in the same round.

1. **The M2 split. (BLOCKS BREAKDOWN)**
   The vision doc states it two incompatible ways: D20 §Questions item 4 says two sprints (M2a = collector + nearby joins + real search; M2b = SDKs); the S2 paragraph says three (collector+log-join, SDKs, trace search + LogsExplorer).
   - **Option A (2 sprints):** fewest handoffs, one sprint owns the whole query layer; but its first sprint is larger than all of S1 (§3 comparison table) and puts the entire M2 exit inside one run.
   - **Option B (3 sprints):** each sprint lands on a usable product, an overrun costs a third of the phase; costs one extra advisor round and one sequential handoff inside `src/server/queries/`.
   - **Sub-question (ordering):** if B, do SDKs land second (as the S2 paragraph lists them) or last (PM recommendation — the exit criterion does not require them, so they cannot hold the milestone's exit hostage)?
   - PM recommendation: **B, with SDKs last.** ADVISOR-OWNED either way.

2. **The pricing M2-vs-M3 contradiction. (BLOCKS BREAKDOWN — it decides whether two items enter M2 at all)**
   S1's escalations log records both pricing items as **M3-GATE** ("pre-registered as M3-GATE items … RESURFACE AT M3 PLANNING"); S1's Goal check for the same run lists the same two items under **M2-gate**. Both statements are in the archived S1 plan.
   - **Rule M2:** the cardinality cap and `prices.json` `as_of` land in whichever sprint owns ingest (S2.A1 / S2.B1). Consequence: small additive work in `internal/pricing` + `internal/metrics`, done before M3's per-workspace override design (D9) builds on the same files; M2 is also when foreign model strings first arrive at scale (collector + SDKs), i.e. when the unbounded-label exposure starts growing.
   - **Rule M3:** they ride the M3 pricing-override design, which touches the same row shape anyway. Consequence: M2 ships with an unbounded metric label from a client-controlled string — acceptable while single-tenant, a real exposure the moment M3 multi-tenancy lands.
   - PM recommendation: **M2**, on the ingest-owning sprint — both are small, and doing them with the override design (M3) means changing pricing twice.

3. **Saved-views persistence in M2. (BLOCKS BREAKDOWN — it decides whether M2 touches Postgres)**
   The M2 exit requires "saved views persisted" (amendment 4; the S2 paragraph says "workspace-persisted"). PRD §6 puts saved views in **Postgres**, and Postgres arrives in **M3** (S3). Today saved views are a hardcoded `const` (`TracesSearch.tsx:11`), the workspace store is in-memory React context (`src/state/workspace-store.tsx`), and the only persistence anywhere is `localStorage` in two dashboard widgets.
   - **(a) Pull a minimal Postgres forward into M2** (one table, one connection). Consequence: a new component and a new compose/K8s dependency enter M2; M3's identity sprint inherits a live database instead of a greenfield one. Contradicts the vision doc's placement of Postgres in M3.
   - **(b) Persist saved views in ClickHouse.** Consequence: no new component, but small mutable app rows in an OLAP store — a pattern the team would have to unwind in M3, and one PRD §6 explicitly assigns to Postgres.
   - **(c) Client-side persistence (`localStorage`) in M2, true workspace persistence in M3.** Consequence: honest and cheap, but "workspace-persisted" in the S2 paragraph becomes false — the exit criterion must be reworded to "saved views persist for the user" or the badge/honesty rules (D21) demand it be labelled.
   - **(d) Amend the M2 exit to drop persistence**, keeping saved views as applied-filter presets until M3.
   - PM recommendation: **(c) with the exit criterion reworded**, or **(a)** if the advisor would rather pay the Postgres cost once. Not PM's call — this changes a milestone exit criterion.

4. **SDK scope: Python-first or parallel Python + TypeScript?**
   PRD §15 explicitly defers this: "Python-first vs. parallel TS launch for SDK polish depth — **decide in Phase 2 planning**." The S2 paragraph names both `obstack-py` and `obstack-js`.
   - **Parallel:** matches the S2 paragraph; roughly doubles the SDK sprint (two auto-instrumentation surfaces — OpenAI/Anthropic for Python, Vercel AI SDK for TS — two package toolchains, two doc sets) and forces packet item 6 (`obstack-js` is what triggers the restructure).
   - **Python-first:** the demo app is already Python (`demo/agent-app/`), so the SDK sprint can be validated against an app that exists; `obstack-js` slides to a follow-on sprint and the restructure question moves with it. Consequence: M2 ships with half the named SDK scope — an explicit amendment to the S2 paragraph, not a silent cut.
   - PM has no evidence to prefer either; PRD names this a Phase-2 planning decision, so it is asked here.

5. **What produces `infra`-layer spans?**
   D8 reserves `infra` in the enum ("reserved for the M2 collector spans and is never assigned here" — `internal/mapping/mapping.go:36`), the S2 paragraph says "collector-originated spans populate the `infra` layer", and **no source document defines a classification rule for it**. `classify()` has no `infra` branch (`internal/mapping/spans.go:102-121`). Separately, `Trace.k8sEvents` exists in the UI contract and is rendered by `Waterfall.tsx`, but the adapter leaves it undefined in live mode by design (`src/server/adapters.ts:7`).
   - **(a) Collector self-telemetry** spans get `layer='infra'`. Cheap, low product value.
   - **(b) Kubernetes events ingested as infra records** (feeding the reserved `K8sEvent` rail). High product value — it is literally the "down to the container it ran on" claim — but it is **net-new scope no source document asks for**, and the PRD places infra views in M5.
   - **(c) Defer:** drop the infra sentence from M2 and let M5's infra bucket own it. `infra` stays a reserved enum value.
   - PM recommendation: **(c)**, because (b) would be invented scope. Flagging rather than choosing.

6. **Monorepo restructure timing — must `apps/web` + `packages/*` precede the SDK sprint?**
   The repo is a single Next.js app at the root (`package.json`, `src/` at root) beside `services/ingest/` (Go) and `demo/agent-app/` (Python). Publishing `obstack-js` from that layout is the natural trigger for the restructure.
   - **(a) Restructure before the SDK sprint** (its own precursor run, or folded into S2.0). Consequence: one mechanical repo-wide move verified once — `tsconfig` `@/` paths, `smoke.sh`/`smoke.ts` path assumptions (`deploy/compose/smoke.sh:13-14,45-47`), Dockerfile build contexts, and any CI paths S2.0 writes. Every later sprint works in the final layout.
   - **(b) Restructure inside the SDK sprint.** Consequence: a repo-wide mechanical move and new-package authoring land in one run — the pattern S1's retro named as the source of its worst failures.
   - **(c) Defer past M2** and ship `obstack-js` from the root layout. Consequence: gets more expensive every sprint; M3 adds Postgres and auth code to the same root tree.
   - Scoped question only: **does the restructure have to precede the SDK sprint?** Design and execution of the restructure are explicitly not in this plan. If (a), the follow-on is whether it folds into S2.0 (one disruption, before CI paths harden) or stands alone.

7. **The M2 exit criterion does not require the SDKs.**
   The exit line is satisfied by K8s + collector + log join + LogsExplorer; the demo app is plain OTel by design (D15). Under either split, an SDK sprint can be unfinished while M2's exit is provably met.
   - **(a) Accept:** the SDK sprint closes on its own exit criterion; the milestone closes when both are done. Consequence: "M2 exit met" and "M2 done" are different dates — must be stated so, or the Run status will lie.
   - **(b) Amend the M2 exit** to include an SDK-instrumented app reaching the same trace. Consequence: honest milestone accounting, and the SDK sprint becomes exit-blocking.

8. **M2's Kubernetes artifact vs M4's Helm chart.**
   D14/M4 owns the Helm chart. M2 needs *something* deployable to kind. The ingest side is ready either way — PR #4 shipped `ingest migrate` plus `OBSTACK_MIGRATE_ON_BOOT=false` precisely for "a `Job` (Helm `pre-install`/`pre-upgrade` hook)" (`deploy/compose/README.md:147-186`), so the multi-replica seam already exists.
   - **(a) Raw manifests / kustomize in M2, replaced by the M4 chart.** Consequence: throwaway work; two deployment paths to keep working until M4.
   - **(b) Start the M4 Helm chart in M2** and use it for kind. Consequence: M4 scope moves into M2 (against the vision doc's placement), but the CI cluster then exercises the artifact customers will actually use.
   - PM notes only that the choice is not derivable from the vision doc or the PRD.

9. **S2.0 / M2 boundary confirmation (cheap).** PM's reading: S2.0 delivers PR guards + the *capability* to create a kind cluster in CI and run a locally built image on it; standing the obstack stack (ClickHouse + ingest + collector + demo) up on that cluster belongs to the M2 sprint that owns the K8s work. Confirm, or move the stack-on-kind deployment into S2.0. (S2.0's existence is the user's decision and is not in question.)

10. **Duplicate log lines on Kubernetes (product-visible).**
    The demo app calls `logging.basicConfig(...)` **and** attaches the OTel `LoggingHandler` to the root logger (`demo/agent-app/main.py:34`, `demo/agent-app/telemetry.py:47-49`). On a cluster, each line therefore leaves twice: via OTLP (carries `trace_id`, no pod metadata unless the resource is enriched) and via stdout tailed by the collector (carries pod metadata, no `trace_id`). The trace's logs rail would show the same text twice — once SOLID, once NEARBY (`src/components/trace/LogsRail.tsx:60-66`). The PRD is silent on this.
    - **(a) Accept and label it** as demonstrating both correlation paths.
    - **(b) Route the app's OTLP through the collector** so `k8sattributes` enriches it — solid logs then carry pod metadata; the duplicate remains unless the stdout handler is dropped.
    - **(c) Give nearby logs a genuine source:** run a second, uninstrumented workload on the cluster whose stdout is the nearby evidence, and stop the demo app's own lines from arriving twice. Most faithful to the PRD's fallback-join story (§5: "logs **without** trace context").
    - **(d) Dedupe in the query layer.** Net-new product behaviour no source document describes.
    - PM recommendation: **(c)**. Whichever is ruled, it belongs in the collector sprint's exit evidence, because "solid **and** nearby in one view" is a literal clause of the M2 exit.

---

## 6. Coverage check (2026-08-16)

M2's exit criterion, decomposed into checkable conditions, each mapped to an owning sprint under both options.

| # | condition (from the M2 exit line + S2 paragraph) | Option A owner | Option B owner | status |
|---|---|---|---|---|
| E1 | CI exists and guards PRs with the M1 suites | S2.0 | S2.0 | covered |
| E2 | CI can create a kind cluster and run a locally built image | S2.0 | S2.0 | covered |
| E3 | obstack stack (ClickHouse + ingest + collector + demo) runs on that kind cluster | S2.A1 | S2.B1 | covered (artifact form open — packet 8) |
| E4 | `obstack-collector` ships as config-only OTel Collector: container form **and** DaemonSet form | S2.A1 | S2.B1 | covered |
| E5 | API→agent→LLM spans render as one trace from the cluster run | S2.A1 | S2.B1 | covered |
| E6 | solid (`trace_id`) pod logs render in the rail | S2.A1 | S2.B1 | covered |
| E7 | nearby ((namespace/pod/container) + window) logs render, visually distinct | S2.A1 | S2.B1 | covered; needs packet 10 for honest evidence |
| E8 | GenAI log-event prompt/completion extraction into the D7 columns | S2.A1 | S2.B1 | covered (carry-forward 3) |
| E9 | collector-originated spans populate the `infra` layer | S2.A1 | S2.B1 | **GAP — undefined in every source (packet 5)** |
| E10 | real trace search: filters + free text over prompts/logs + honest totals + pagination | S2.A1 | S2.B2 | covered (carry-forwards 1, 2, 7) |
| E11 | LogsExplorer runs on real `logs`-table search | S2.A1 | S2.B2 | covered |
| E12 | saved views persisted per workspace | S2.A1 | S2.B2 | **GAP — no store exists before M3's Postgres (packet 3)** |
| E13 | `obstack-py` SDK: OpenAI/Anthropic auto-instrumentation + `@trace_agent` | S2.A2 | S2.B3 | covered |
| E14 | `obstack-js` SDK: Vercel-AI/OpenAI/Anthropic auto-instrumentation + `traceAgent` | S2.A2 | S2.B3 | covered, **conditional on packet 4** (Python-first would defer it) |
| E15 | live-wired surfaces carry no SAMPLE badge and show real empty states (D13/D21) | S2.A1 | S2.B2 | covered (carry-forward 8) |

Standing checks:
- **Every milestone → ≥1 sprint.** M2 → S2.0 + (S2.A1, S2.A2) or (S2.B1, S2.B2, S2.B3). PASS.
- **Every acceptance criterion → a sprint.** E1–E15 above; two conditions (E9, E12) are blocked on advisor rulings rather than assigned. PASS with 2 recorded gaps.
- **Every deployment impact → a deploy sprint.** M2 has **no** deployment impact: the cluster is a CI kind cluster, not a hosted environment, and the vision doc's coverage check already records deployment as M4-only (S5, type: deploy). **No deploy sprint is created for M2.** If the advisor rules a hosted M2 demo environment into scope, that is new scope and needs a deploy sprint plus the user's provider decision (still unmade — vision doc Questions item 3). PASS.
- **Every product surface touched → an owning milestone.** M2 adds exactly one surface from the 29-row map: `logs`. `traces`, `traces/[id]` and `overview` are M1-owned and are extended, not newly owned. No M5/M6/M7 surface is pulled forward. PASS.

**Gaps, recorded honestly:**
1. **E9 (`infra` layer)** — no source document says what an infra span is. Cannot be planned into a task without packet item 5.
2. **E12 (saved-views persistence)** — the M2 exit requires persistence; the store PRD §6 names (Postgres) is an M3 deliverable. Cannot be planned without packet item 3; one of its options changes the M2 exit wording.
3. **The M2 exit criterion under-covers M2's stated scope** — SDKs (E13/E14) are not required by the exit line. Packet item 7.
4. **Pricing carry-forwards 5 and 6 are unassigned** pending packet item 2 — the two S1 documents contradict each other.
5. **This plan has no task breakdown by design** (D20 process constraint). Sprint sizes are estimated by analogy with S1, not measured. If Option A is ruled, the size risk on S2.A1 is real and unmitigated at this altitude.

---

## 7. Open questions and risks (no ruling needed now)

- **Free-text over log bodies may want a schema change.** `obstack.logs` has a bloom filter on `k8s_pod` only; a substring search over `body` across a day partition is a full scan. A `tokenbf_v1`/`ngrambf_v1` index on `body` would fix it. The repo is still **pre-release**, so the `docker compose down -v` precedent (D22, F5) makes such a migration free — that window closes the moment M3 puts a stranger's data in the table. If the search sprint needs it, M2 is the cheap moment.
- **CI cost/time.** A kind job that builds the ingest and demo images and boots ClickHouse on every PR is minutes, not seconds. S2.0 should decide (at breakdown) whether the kind job runs on every PR or only on a label/main — a dev-team call, recorded here so it is not discovered late.
- **Collector version pinning.** D14's precedent (exact LTS pin for ClickHouse, `docker-compose.yml:5`) should extend to the collector image; "config, not fork" (PRD §5) means the config is obstack's and the binary is upstream's, so an unpinned tag is an unversioned dependency.
- **Solid logs may have no pod metadata.** OTLP logs from the app carry `trace_id` but no `k8s_*` unless the resource is enriched (downward API or routing through the collector). The rail renders `l.pod` for every row (`LogsRail.tsx:53-57`), so solid rows would show an empty pod on K8s. Related to packet item 10; likely resolved by the same ruling.
- **"±10s" is hardcoded UI copy.** `TraceExplorer.tsx:212` already tells the user the nearby window is "same pods, ±10s". Whatever window the nearby join actually uses must match that string, or the string must become data.
- **Multi-replica ingest on kind.** `OBSTACK_MIGRATE_ON_BOOT=false` + a migrate Job is already documented (`deploy/compose/README.md:147-186`) but has never been executed on a real cluster. The first kind deployment is the first real test of PR #4's guarantee — a good outcome either way, but it is a first-run risk, not a settled path.
- **The demo app is the only instrumented app.** Both SDK sprints need a sample app to prove themselves. Whether that is a new sample, a second entry point in `demo/agent-app/`, or a TS sibling is a breakdown-time question — but it is real work that no source document names.

---

---

## 8. Advisor rulings (D28–D37, 2026-08-16) — BINDING

The advisor verified every code citation in this plan against `master` @ `6108abc` before ruling ("the plan's evidence is sound"). Rulings condensed here; this section supersedes §3's provisional IDs.

### D28 (packet 1) — Split: Option B, corrected order, final sprint IDs

D20's two-seam presumption is CORRECTED (D20's own text made the seams presumptive, to be confirmed or corrected at phase planning — this is the correction). S2.A1 would be strictly larger than S1, the only calibration data this project has; the entire M2 exit does not go inside one run. Final structure, sequential dispatch:

| id | sprint | absorbs |
|---|---|---|
| **S2.0** | CI foundation + kind capability | boundary per D36 |
| **S2.1** | monorepo restructure (`apps/web` + workspaces) — NEW per D33 | — |
| **S2.2** | collector distro + nearby log join on kind (was B1) | D35 Helm ruling, D37 dup/join ruling, carry-forward 3 |
| **S2.3** | real trace+log search + LogsExplorer + saved views (was B2) | D30 store ruling, carry-forwards 1/2/7/8 |
| **S2.4** | SDKs + auto-instrumentation (was B3) | D31 scope (user-owned), requires S2.1 |

SDKs last: the exit line cannot be held hostage by the one sprint it doesn't require (see D34). The `src/server/queries/` S2.2→S2.3 handoff is documented-sequential: S2.2 adds a second logs query, it does not restructure `traces.ts`.

### D29 (packet 2) — Pricing: M3-GATE stands; Goal-check ledger entry was a transcription error

The escalations log is the ruling record; the Goal-check line mis-filed it. Carry-forward rows 5 and 6 **leave the M2 ledger**. On merits: the label exposure only becomes stranger-controlled at M3 multi-tenancy, and both items touch the same files as M3's D9 override design — together at M3 touches pricing once. **M3-GATE, BLOCKING: the cap merges before a second workspace's data can arrive.**

### D30 (packet 3) — Saved views: option (c), localStorage behind one client store module. **USER-VISIBLE — pending user sign-off**

(a) REFUSED: Postgres before identity is a layer ahead of its foundation (workspace id is an env default today). (b) REFUSED: mutable app rows in an OLAP store is a stopgap by construction. (c) is correct design for a pre-identity single-user product (precedent: `OnboardingChecklist.tsx`, `WatchWidgets.tsx`), and M3's move is scope growth, not rework. Exact M2-exit replacement wording (pending user sign-off): *"and the LogsExplorer surface searches real logs with saved views that persist per browser (localStorage) and survive a reload — workspace-scoped saved views land with Postgres in M3 (PRD §6), pre-registered as an M3-gate item."* S2.3's exit drops "and a new browser"; gains: one client store module, UI never labels views workspace-scoped. M3 deletes the localStorage path outright — no dual-store layer (M3-GATE).

### D31 (packet 4) — SDK scope: **USER-OWNED**; advisor recommendation: parallel py+js, Python as validation lead

PRD §15 words this as launch polish depth — product scope. Recommendation rationale: M3's onboarding quickstart renders a TS tab (Python-first with no `obstack-js` owner strands it as D13/D21-class fiction); Vercel-AI is the JS wedge for the ICP; the restructure trigger fired either way. Python validates against `demo/agent-app/` (exists); `obstack-js` needs a minimal TS sample app — real work no source doc names, breakdown must create it. If the user rules Python-first: explicit S2-paragraph amendment + named `obstack-js` owner sprint becomes an M3-planning blocker.

### D32 (packet 5) — `infra` layer: DEFER; the S2-paragraph sentence is STRUCK

"Collector-originated spans populate the `infra` layer" is unimplementable as written — a config-only filelog/k8sattributes collector originates logs, not spans; its self-telemetry is junk in product traces. K8s-events-as-infra is net-new scope (amendment 7 refuses it; PRD puts infra views in M5). E9 removed from the exit decomposition; `infra` stays reserved; `classify()` gains no branch; collector self-telemetry classifies under existing D8 rules. **M5-GATE: define the infra producer rule at M5 planning.**

### D33 (packet 6) — Restructure: PRECEDES the SDK sprint, as STANDALONE sprint S2.1, directly after S2.0

Not folded into S2.0 (user fixed its fence at "CI capability only"; stronger sequencing is CI first, then the mechanical move guarded by the CI it just built). Placed before S2.2/S2.3 so collector Helm files and search work land in the final layout once, at minimum code mass. S2.1 is purely mechanical: move existing code, npm workspaces (`apps/web`), tsconfig paths, smoke.sh/smoke.ts paths, Dockerfile contexts, CI paths — one PR. `packages/obstack-js` is created by S2.4, not S2.1 (no empty scaffolding). Exit: CI green on the restructure PR + `smoke.sh` green from clean volumes + full web suite from the new root. **Critical item: the restructure PR returns to the advisor before merge.**

### D34 (packet 7) — M2 exit AMENDED to include the SDK proof. **USER-VISIBLE — pending user sign-off**

New exit clause: *"and a sample app instrumented only with the obstack SDK (install + the documented two-line setup) produces the same four-layer trace."* Rationale: amendment 4's precedent — the exit names everything the milestone must prove (LogsExplorer was pulled in on exactly that principle). Option (a)'s "exit met but milestone open" state is refused as permanent Run-status caveat. Consequence accepted knowingly: **S2.4 becomes exit-blocking.**

### D35 (packet 8) — K8s artifact: the M4 Helm chart STARTS in M2, scoped

Throwaway manifests REFUSED categorically (built-to-be-replaced). M2 already requires a K8s artifact — this ruling chooses its form, it does not import M4 features. M2 chart scope: CI-grade ClickHouse; ingest Deployment with `OBSTACK_MIGRATE_ON_BOOT=false` + migrate `Job` as `pre-install`/`pre-upgrade` hook (PR #4's design, first real execution); collector DaemonSet; demo app. **NOT in it:** the `web` image (M4 — CI asserts via the D17 tsx facade harness against the cluster's ClickHouse), TTL tiers, docs, self-hosted values. Helm is the ONLY kind path; collector image pinned to an exact upstream version (D14 precedent). **M4-GATE: M4 extends this chart in place — a second chart is drift.**

### D36 (packet 9) — S2.0 boundary CONFIRMED as the PM read it

PR guards + kind capability (create cluster, load local image, workload Ready); stack-on-kind is S2.2. Additionally binding: the `t.Skipf` skip-trap paragraph is part of S2.0's **exit**, not advice — CI runs ClickHouse as a service with `OBSTACK_TEST_CLICKHOUSE_DSN`/`OBSTACK_TEST_CLICKHOUSE_READONLY_DSN` set, and unexpected skips fail the job. Proven-by-failure stays.

### D37 (packet 10) — Duplicate logs: (b)+(c) combined; mechanism binding on S2.2

1. App OTLP routes through the collector → `k8sattributes` enriches spans + logs; SOLID rows carry real pod metadata (closes the §7 empty-`l.pod` risk). 2. Nearby evidence gets a genuine source: a second, uninstrumented container in the demo pod whose stdout the collector tails — PRD §5's fallback join literally. 3. No line arrives twice: collector filelog excludes containers shipping via OTLP; app keeps writing stdout (`kubectl logs` stays truthful); exclusion documented as the recommended customer pattern. 4. **Nearby join key ruled now:** `(workspace_id, k8s_namespace, k8s_pod)` + time window; container is display data. Window is one shared constant surfaced to the UI — `TraceExplorer.tsx`'s hardcoded "±10s" becomes data. 5. Query-layer dedupe REJECTED (lies about the data). **S2.2 exit evidence: ≥1 SOLID row with pod metadata, ≥1 NEARBY row from the uninstrumented container, zero duplicated bodies.**

### Verdict and gates

**APPROVED FOR TASK BREAKDOWN** once these rulings are applied to the planning docs AND the user signs the two USER-VISIBLE exit changes (D30, D34) and answers the USER-OWNED item (D31). **S2.0 and S2.1 breakdown may begin immediately** (no user item touches them); S2.2+ breakdown waits on the user round. D32's strike of the infra sentence rides the user notice for visibility (ruled, not pending approval).

Gate items pre-registered by these rulings: M3-GATE pricing cap + `as_of` (blocking multi-tenant ingest); M3-GATE saved-views → Postgres, localStorage path deleted; conditional M3-planning blocker if Python-first (named `obstack-js` owner); M4-GATE Helm chart extended in place; M5-GATE infra producer rule.

Critical items returning to the advisor at breakdown/merge time: S2.1 restructure PR; S2.2 collector config + chart structure + nearby-join SQL + D37 evidence; S2.3 search/pagination SQL contract + any `body`-index migration (pre-release `down -v` window per D22/F5 — M2 is the cheap moment); S2.4 SDK public API + D8/D8-AMENDMENT conformance; the M2 exit-evidence bundle.

---

## Run log (this plan)

- 2026-08-16 — S2 phase plan written at sprint altitude. S2.0 recorded as a user-decided precursor sprint (CI does not exist: no `.github/`, PRs #3/#4 merged unguarded, M2's exit requires a kind cluster in CI). Both M2 split options written out with exit criteria, scope fences and demoable increments; the split is ADVISOR-OWNED. Decision packet: 10 items, 3 blocking. Coverage check recorded with 5 honest gaps. **No task breakdown produced — per D20, this returns to the advisor first.**
- 2026-08-16 — **User round complete (same day): all three items signed.** D30 rewording SIGNED; D34 amendment SIGNED (S2.4 is exit-blocking); D31 = **parallel py+js** (advisor recommendation accepted — breakdown must create the minimal TS sample app task, and the conditional M3-planning blocker for Python-first is void). The vision doc's S2 paragraph now carries the amended exit text. **Task breakdown is cleared for all five sprints S2.0–S2.4.**
- 2026-08-16 — **Advisor ruled: D28–D37 recorded in §8.** Split = Option B + a new standalone restructure sprint (S2.0→S2.1→S2.2→S2.3→S2.4, SDKs last). Pricing back to M3-GATE (ledger transcription error corrected). Saved views = localStorage with exit rewording (USER-VISIBLE). SDK scope = USER-OWNED (rec: parallel). Infra sentence struck (M5-GATE). Restructure = S2.1, before all M2 dev work, critical-item PR. M2 exit gains the SDK clause (USER-VISIBLE). Helm chart starts in M2, scoped (M4-GATE: extended in place). S2.0 boundary confirmed + skip-trap made exit-binding. Dup-logs mechanism ruled (collector-routed OTLP + uninstrumented sidecar + filelog exclusion + join key `(workspace_id, ns, pod)` + shared window constant). Plan APPROVED for breakdown pending the user round on D30/D34/D31.
