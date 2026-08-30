# S4 — M4 Launch Hardening — Phase Plan (sprint altitude)

meta:
- date: 2026-08-23
- repo/branch: `m4-planning` @ `a11ae7a` (identical tree to `master`; the working tree carries one untracked idea doc, `.planning/2026-08-20-idea-agent-driven-integration.md`, whose hosting-direction notes are §6 decision input — the idea itself is NOT M4 scope, see packet 15)
- source of truth: `.planning/2026-08-15-obstack-backend-build-vision.md` (S4/S5 paragraphs lines 56–70, coverage map + amendment 6, Questions item 3) + `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md` §5 (same-images hard constraint, line 28) / §6.2 / §10 / §11 / §13 (Phase 4 row, line 171) + `.planning/2026-08-20-m3-milestone-bundle.md` (the consolidated M4/S5 gate inventory, lines 20–25) + the five S3.x exit bundles and rulings ledgers D1–D249
- **inventory caution, stated up front:** the milestone bundle's M4 list is *narrower* than the per-sprint exit bundles — D178/D187, D180, D153/D119/D123/D132 and the eslint/no-CI-lint debt are live via each bundle's "prior inventory unchanged" clause (`2026-08-20-s3.4-exit-evidence.md:44`, `2026-08-19-s3.3-exit-evidence.md:64`, `2026-08-19-s3.2-exit-evidence.md:61`). §4 enumerates from the sprint bundles, not the summary.
- owner: project manager (plan only — no implementation, no task breakdown)
- process constraint (advisor D20): **this plan returns to the advisor BEFORE task breakdown.** No T-numbers, no waves, no file ownership — the same constraint the S2 and S3 phase plans ran under.
- predecessor: **S3 / M3 — Product Shell — CLOSED (2026-08-20).** All five sprints S3.1–S3.5 complete; the D104 user-signed exit met clause-by-clause on the U9 method; milestone bundle advisor-signed (`.planning/2026-08-20-m3-milestone-bundle.md` @ effective tip `2443922`, PR #20 merged @ `f1bba82`). Eight checks green at the signed tip; the every-PR set is eight per D137 (`web`, `go`, `kind`, `stack`, `e2e`, `sdk-py`, `sdk-js`, `sdk-e2e`).

---

## 1. FINAL GOAL VISION — M4

M4 is done when obstack stops being a product that exists only on the builder's machine and becomes one anybody can run and everybody can reach: a clean checkout produces a `web` image and an `ingest` image, and those **same images** — the PRD's day-one hard constraint, discharged here — boot the full stack from one compose bundle or one `helm install`, with retention-tier TTLs actually deleting what the pricing page says they delete and the settings disclaimer that admitted otherwise removed in the same breath; a quickstart-first docs site builds from the same content source the in-app docs render, `/status` reports real uptime from an external monitor instead of a seeded random number generator, `/changelog` is driven by release notes instead of a hardcoded array, and the landing page drops its "prototype — all data on this site is fictional" footer because it is no longer true; the Vercel log-drain receiver and the CloudWatch forwarder exist as built, CI-exercised artifacts waiting only for the public endpoint S5 provides; and then S5 ships it — the cloud SaaS, the public demo, and the docs site stand on the user's chosen provider under the user's domain, the Polar rail flips from sandbox to production as a checklist-carrying promotion, `/signup` is reachable by an actual stranger on the actual internet, and the first five design partners are activated on it. Exit (whole milestone, PRD §13): **first 5 design partners activated; public launch.**

---

## 2. Calibration — updated through M3

Measured from the run record. The M2 reading ("one new component, or one coherent area, per run — 4–6 planned tasks, ~3 waves") survived five more runs unchanged:

| sprint | scope shape | task-slots | advisor rulings | note |
|---|---|---|---|---|
| S1 (M1) | whole pipeline, many areas at once | 20 | D1–D27 | the anti-pattern: interrupted, 8 fix tasks |
| S2.0–S2.4 | one area each | 4–10 | D28–D93 | all landed |
| S3.1 | Postgres + tenancy refit | 16 | D111–D137 (27) | FIXED-GO r1 |
| S3.2 | keys + invites + settings | 10 | D138–D160 (23) | FIXED-GO r1 |
| S3.3 | metering + Polar + quota | 16 (+7 QA slots) | D161–D194 (+D195–D200) | GO r1; QA round FAIL→PASS |
| S3.4 | onboarding + connections | 12 | D201–D222 (22) | GO r1, zero seam fixes |
| S3.5 | Explain + honesty pass | 15 | D223–D249 (27) | FIXED-GO r1 |

**The reading that governs §3:** the sustainable unit is still one coherent area per run. The two 16-slot runs (S3.1, S3.3) each owned exactly one area and still needed fix waves; nothing in eleven closed runs suggests a multi-area sprint has become safe. S4 as written in the vision doc's single paragraph spans **at least four unrelated areas** (containerization/bundle, ClickHouse retention enforcement, two net-new ingest receivers, and an entire content/docs surface) — the S1 shape, on the S1 evidence.

---

## 3. M4 sprint-level split — ALL options

The **S4 (build, dev-team) / S5 (ship, deploy-team) seam is fixed by the vision doc** and is not reopened here: only M4 carries deployment impact, and S5 is its deploy sprint (vision lines 56–70, standing check "every deployment impact → a deploy sprint"). The decidable is whether S4's build half is one run. The split is **ADVISOR-OWNED**; sprint IDs are provisional until ruled.

**Common to every option — the S4 build-half exit, verbatim (vision line 62):** *"a clean checkout produces the web + ingest images, the compose profile and Helm chart both boot the full stack from those images with tier TTLs applied, and docs/status/changelog content builds."*

**Common foundation facts** (verified 2026-08-23 on `a11ae7a`, full citations in §8):

1. **The `web` image does not exist in any form.** No Dockerfile under `apps/web`; `next.config.ts:1-11` has no `output` key (no standalone build); compose *deliberately* does not run the web app — `deploy/compose/docker-compose.yml:38-42`: "Compose does not run the web app, and auth secrets belong to the process that actually signs cookies."
2. **The chart's self-hosted surface is entirely unbuilt, by ruling.** `values.yaml:1-8` states the fence verbatim ("No self-hosted values surface here — no ingress, no TLS, no resource sizing, no secret backend selection, no `web` image, no TTL tiers. That is M4's job"); zero Ingress/Secret/PVC/resource-limit objects exist in `templates/`; ClickHouse and Postgres are Deployments on `hostPath` and the chart README pre-commits M4 to "StatefulSets and PVCs" (`deploy/helm/obstack/README.md:50-53`).
3. **Retention enforcement is a single hardcoded 30-day TTL on all three D7 tables** (`services/ingest/migrations/0001_spans.sql:46`, `0002_logs.sql:35`, `0003_trace_summaries.sql:42`) — no per-tier, no per-workspace anything. The tier lives only as `plans.retention_days` (`pgmigrations/0005_metering.sql:118-124`) and the D105 disclaimer sentence is live at `SettingsSuite.tsx:726`.

### Option A — S4 as one run (the vision doc's literal numbering)

- **run-goal (verbatim to dev-team):** obstack M4 build — the distributable product (exit: the S4 build-half exit line above, whole).
- **PM size note:** containerization + a chart values-surface + a ClickHouse retention mechanism + two net-new receivers + a docs site + three content surfaces + a landing pass ≈ **larger than S1**, the one run this project has failed to land in one pass. The same evidence that produced D28 (M2) and D94 (M3) is on the table a third time. Unmitigated at this altitude.

### Option B — two sprints: backend, then content

- **S4.B1 — the distributable artifact + ingest hardening:** web image, compose bundle, chart self-hosted surface, build-env enforcement, TTL tiers + disclaimer removal, Writer.Close bound, Vercel/CloudWatch receivers.
- **S4.B2 — docs site, in-app docs, /status, /changelog, landing pass.**
- **PM size note:** B1 batches containerization, chart surgery, a retention mechanism and two receivers — four areas, ≈ S1 minus the UI half. Smaller than A; still the batching shape.

### Option C — PM recommendation: three sprints, sequential

#### S4.C1 → provisional **S4.1** — the distributable artifact
- milestone: M4 · type: dev · dependencies: S3 (CLOSED)
- **run-goal (verbatim to dev-team):** obstack M4 sprint 1 — the distributable artifact (exit: a clean checkout produces the web and ingest images, the compose bundle and the Helm chart both boot the full stack from those same images, a mode-mismatched serve of the web artifact refuses rather than renders, and ingest shuts down cleanly inside the chart's termination grace).
- **exit criterion:** `apps/web` builds as a Next standalone image from a Dockerfile in this repo; compose gains a `web` service so `docker compose up` boots the full self-hosted stack (ClickHouse, Postgres, ingest, web) from the built images with the auth-secret posture stated; the chart gains the `web` workload **in place** (D35 — never a second chart) plus the self-hosted values surface D35 enumerates (ingress/TLS, resource sizing, a secret story, the managed-Postgres values surface, the D123 `postgres.password` rotation story) at whatever depth packet 4 rules exit-required; ClickHouse and Postgres move to the StatefulSet+PVC shape the chart README pre-commits (`README.md:50-53`) or the advisor rules that deferral out loud; the S2.3 L6/D157 build-env invariant gains its **enforcement mechanism** at its raised stakes ("costs signup entirely") — the artifact is mode-stamped and a mismatched serve is a refusal, with the S1 repro (`npm run build` reuses cached prerenders across `OBSTACK_DATA_MODE` changes; matrix checks need `rm -rf .next` first) closed; the S1 T12 badge build-vs-runtime seam is re-decided as pre-registered; `Writer.Close` is bounded and wired to the chart's termination grace (today `write.go:145-151`'s `Close()` takes no context and `main.go:287` does not pass the 10s `shutdownCtx` into it; `batcher.go:143-147` blocks unbounded).
- **scope fence:** no TTL work, no receivers, no docs/status/changelog/landing content, no deployment, no provider assumptions. The `stack`/`e2e` jobs grow in place only as far as the new workloads require (K3: no renames).
- **independently demoable as:** "clone, build, `helm install`, sign up on your own cluster" — the self-hosted product, real for the first time.
- **PM size note:** one new image + one chart surgery + one enforcement mechanism ≈ S2.2's class (new component + deploy-target work). The chart surgery is the risk: stateful workload migration is the first change of its kind here.

#### S4.C2 → provisional **S4.2** — ingest launch hardening: retention TTLs + the M4 receivers
- milestone: M4 · type: dev · dependencies: S4.1 (the receivers ship inside the ingest image S4.1's bundle boots; sequential per the D94 precedent)
- **run-goal (verbatim to dev-team):** obstack M4 sprint 2 — retention enforcement and the launch receivers (exit: retention-tier TTLs are enforced on the D7 tables per workspace plan and the settings disclaimer is removed in the same change, and the Vercel log-drain receiver and CloudWatch forwarder artifact exist, CI-exercised against local requests, still honestly "Coming soon" in the hub until S5 activates them).
- **exit criterion:** per-tier retention enforcement lands on `spans`/`logs`/`trace_summaries` by the mechanism packet 3 rules, provably deleting data past a workspace's `plans.retention_days` and provably keeping data inside it; **the `SettingsSuite.tsx:726` disclaimer is removed in the same sprint (D105's own clause)** and the plan surfaces stop stating an unenforced entitlement; the Vercel log-drain receiver (ingest-side HTTP endpoint speaking Vercel's drain schema) and the CloudWatch forwarder artifact (subscription-filter destination in the standard pattern) are built and exercised in CI via local POSTs (S2.2 L1 satisfied by real requests, not by activation claims) — per D101 the hub cards stay "Coming soon" until S5 activates them against a public endpoint; the D218 windowed-rate counter schema lands if packet 11 rules it in; the D178 SDK-bump re-measure done-check runs if `@polar-sh/sdk` moves.
- **scope fence:** no web-image work (S4.1 owns it), no content surfaces, no public endpoint, no card status flip (S5's), no GCP/Azure/Heroku-class receivers (idea-doc backlog, packet 15).
- **independently demoable as:** "the free tier's 7 days is real, and a Vercel drain pointed at a local endpoint lands logs in a workspace."

#### S4.C3 → provisional **S4.3** — docs, status, changelog, landing: the launch content pass
- milestone: M4 · type: dev · dependencies: S4.1 (the docs document the S4.1 bundle) and S4.2 (the connectors pages document the receivers)
- **run-goal (verbatim to dev-team):** obstack M4 sprint 3 — docs, status, changelog and the landing launch pass (exit: a quickstart-first docs site builds from the same content source the in-app docs render, /status and /changelog tell the truth by construction, and the landing page carries launch copy with no fiction left).
- **exit criterion:** a docs site builds from tracked content in this repo (architecture per packet 6), quickstart-first (PRD §11), documenting the real product: signup, quickstart (the D78 frozen API), the self-hosted bundle (compose + chart from S4.1), connectors, Explain, billing; the **in-app docs surface renders the same content source** (amendment 6) and the fictional Loopwork runbook corpus (`apps/web/src/mock/docs.ts`) is re-labelled or replaced per its ruled disposition; `/status` stops being the seeded-PRNG Loopwork demo (`app/status/page.tsx:14-38`) and becomes the amendment-6 shape — external uptime monitor + manually curated incident notices, no bespoke backend — with S4 building the page/pipeline and S5 wiring the monitor; `/changelog`'s hardcoded array (`app/changelog/page.tsx:17-45`) becomes release-note-driven as part of the docs pipeline; the landing page takes its final launch pass — the `page.tsx:547` "prototype — all data on this site is fictional" footer, the nav's missing Docs/Status links (`:56-59`), the hand-restated pricing block (`:397-405` D226 comment), and the waitlist block's post-launch disposition all resolved per packet 8.
- **scope fence:** no product-feature work, no deployment, no monitor account creation (S5/U12). The honesty rules (D13/D21) bind every new surface.
- **independently demoable as:** "read the docs, follow them, and everything they say is true."

### Option comparison

| dimension | A (1 sprint) | B (2) | C (3, PM rec) |
|---|---|---|---|
| largest sprint vs §2 | **> S1** | ≈ S1 minus UI | ≈ S2.2 class each |
| unrelated areas batched | 4+ | B1 batches 4 | none |
| cost if first run overruns | everything | the whole backend | the artifact lands; TTL/receivers/content are separate runs |
| advisor rounds | 1 | 2 | 3 |

**PM recommendation (advisor-owned): Option C, sequential S4.1 → S4.2 → S4.3, then S5.** Same grounds as D28 and D94: the only overruns on record batched areas; every split option's sprints land on a working, demoable product (D20's constraint). The build-half exit line is met at the end of S4.3; the milestone exit (design partners + public launch) is met at S5 — **no D34 tension exists here** because the vision doc already writes the build-half exit and the milestone exit separately (lines 62, 70).

### S5 — M4 Launch Hardening, ship (deploy-team; unchanged from the vision doc)

- milestone: M4 · type: **deploy** · dependencies: last S4 dev sprint · **blocked on U10/U11 (provider + domain) — cannot be sequenced into tasks until they are named** (vision Questions item 3, standing since 2026-08-15).
- **run-goal (verbatim to deploy-team, when dispatched):** obstack M4 ship — deploy the S4 images (exit: the cloud SaaS, public demo and docs site are live on the chosen provider under the chosen domain, a stranger reaches `/signup` over the public internet, the Polar rail runs in production, and the first 5 design partners are activated).
- **S5-GATE inventory it must carry (from §4):** the Polar sandbox→production promotion as a checklist-carrying critical item (D173.5) with the D177 five-name env inventory and the D200 webhook-reachability consequence (unreachable webhooks leave rail-originated revocations unapplied) and a re-verification of the D104 exit clauses against the production rail; D23/D103(b) dup-exposure revisit on design-partner evidence; `/signup` public-reachability with abuse controls (pre-registered risk, S3 plan `:598`); the hosted env inventory (`BETTER_AUTH_URL` D119, `BLOB_READ_WRITE_TOKEN`, `postgres.password` rotation D123 as shipped by S4.1, the Polar names); receiver activation + SOON-card flip (D101); the S3.3 QA out-of-area flags (fake-secret line, better-auth direct-signup provisioning, Content-Encoding case).

---

## 4. Carry-forward ledger — every M4/S5 item on the record

Verified against the cited sources by the compilation pass of 2026-08-23. Owner columns are under Option C (A/B collapse accordingly).

| # | item | source | owner |
|---|---|---|---|
| 1 | **D105 — retention TTL enforcement on the D7 tables + disclaimer removal, SAME sprint** ("M4-GATE: TTL enforcement on the D7 tables + removal of the disclaimer, in the same sprint") | S3 plan `:512-514`; disclaimer live at `SettingsSuite.tsx:726`, `0005_metering.sql:110-113` | **S4.2** |
| 2 | **D35 — chart extended in place; M4 owns: `web` image, TTL tiers, ingress/TLS, resource sizing, secret backend, self-hosted values, managed-Postgres values** | S2 plan `:293-295`; S3 plan `:195`; `values.yaml:1-8`; `README.md:36-55` | S4.1 (TTL rider: S4.2) |
| 3 | **S2.3 L6 + D157 — build-env enforcement at raised stakes**: artifact mode-stamped, mismatched serve refuses; "costs signup entirely"; documented at `data.ts:71-73`; S1 repro: cached prerenders across mode changes | `s2.3-team-plan.md:318,327`; `s3.2-team-plan.md:134` | **S4.1** |
| 4 | **S1 T12 — badge/page build-vs-runtime mode seam re-decided at M4** (runtime env read or forced-dynamic shell) | `s1-team-plan-final.md:254,276` | S4.1 (with #3 — "mechanism decided once at M4") |
| 5 | **`Writer.Close` bound with Helm grace periods** — deferral "ratified until M4 Helm grace periods"; today unbounded (`write.go:145-151`, `batcher.go:143-147`, `main.go:287` passes no ctx) | `s1-team-plan-final.md:248,276` | **S4.1** |
| 6 | **D101 — Vercel log-drain + CloudWatch receivers: S4 builds, S5 activates**; SOON cards flip only at S5 (D208: card availability is a product claim in both modes) | S3 plan `:488`; `connectors.ts:125-145` | **S4.2** build / **S5** activate |
| 7 | **D101/D88 — `ai@7` integration: named-owner obligation AT M4 PLANNING** (the `diagnostics_channel`/`AI_SDK_TELEMETRY_INTEGRATIONS` path; D78 freeze governs — additive or it escalates) | S3 plan `:490`; `s2.4-team-plan.md:77` | **named in packet 9** |
| 8 | **D103(a) — JS logging bridge / streaming instrumentation / Responses API: revisit with launch-polish scope** | S3 plan `:499-501` | **decided in packet 10** |
| 9 | **D218 — windowed-rate counter schema on the D100 mechanism** (cumulative+as-of was a signed exit-wording deviation; a /min figure was refused as invented) | `s3.4-team-plan.md:142-143` | **decided in packet 11** (natural home S4.2) |
| 10 | **D214 — external-cluster connect = a network-reachable self-hosted ingest surface**; chart ships no key-issuing surface until the `web` workload (D221 values comment) | `s3.4-team-plan.md:127-128,149`; `connectors.ts:90`; `lib/ingest-endpoint.ts:15-31` hardcodes `127.0.0.1` | **S4.1** (the endpoint/values half) + S5 (reachability) |
| 11 | **D123 — `postgres.password` rotation story lands with M4's self-hosted values surface** | `s3.1-team-plan.md:235` | S4.1 |
| 12 | **Hosted env inventory** — `BETTER_AUTH_URL` (D119; setting `http://` downgrades the production cookie), `BLOB_READ_WRITE_TOKEN` (waitlist PR #15), D177's five Polar names, `OBSTACK_EXPLAIN_*` | `s3.1-exit-evidence.md:40`; `s3.2-exit-evidence.md:61`; `s3.3-exit-evidence.md:30` | S4.1 documents; **S5** provisions |
| 13 | **D132 — NoSessionError log-volume note** | `s3.1-team-plan.md:255` | M4 inventory — packet 12 names or defers |
| 14 | **D153 — expired-invitation lifecycle (no reaper) — recorded absence** | `s3.2-team-plan.md:147` | M4 inventory — packet 12 names or defers |
| 15 | **D178 — any `@polar-sh/sdk` bump re-measures the webhook event enum; standing done-check** | `s3.3-team-plan.md:183` | standing, any S4 sprint that bumps |
| 16 | **D180 — per-row/savepoint flush fallback, gated on the first workspace-deletion surface** | `s3.3-team-plan.md:185` | gated — **not M4 unless a deletion surface appears** (retention TTL deletes data, not workspaces; packet 3 states whether the gate fires) |
| 17 | **eslint: 6 pre-existing errors, no CI lint job — "M4's CI surface is the natural home"** | `s3.2-exit-evidence.md:61`; `s3.3-qa-fixes-plan.md:72` | **packet 12** |
| 18 | **G1 — mock-guard settings-action enumeration is hand-maintained; watch continues** | `s3.3-qa-fixes-plan.md:72,76`; `s3.4-team-plan.md:49` | standing; S5-GATE watch |
| 19 | **Environment-ordering test class — `down -v` before DSN-backed suites in any evidence sequence** (drive's D172 overrides poison shared compose Postgres) | `s3.5-exit-evidence.md:28`; `s3.5-team-plan.md:233` | standing operational line, every S4 sprint |
| 20 | **CI headroom** — `e2e` 5m47s/5m50s at the M3 tip (~10s under the K5 line; D137 watch: three consecutive over → over-branch; **D207 propagation-wait reclaim pre-authorized as the first response, not consumed**); `stack` 5m04–5m12s in range | S3 plan `:570-574`; `s3.4-team-plan.md:104-105`; `s3.5-exit-evidence.md:20` | every S4 sprint inherits the number consciously |
| 21 | **S5-GATE block** — Polar production promotion (D173.5 + D177 + D200) with D104 re-verification; D23/D103(b); `/signup` reachability + abuse controls; out-of-area QA flags | `m3-milestone-bundle.md:24`; S3 plan `:568,598`; `s3.3-qa-fixes-plan.md:76` | **S5** |
| 22 | **Reopen-on-measurement** — D109 (skip index), D243 (per-view quota read): closed; reopen only on a measured number from real scale | `m3-milestone-bundle.md:25` | none — recorded so no sprint absorbs them |

### Explicitly NOT M4 (recorded so no sprint drifts into it)

- **The two idea-doc items** — agent-driven integration (MCP/skill/CLI vehicles) and the non-OTLP ingestion paths (obstack-agent, syslog, Fluent/Vector sinks, Loki/Elastic wire-compat, logging-library handlers, cloud log routers beyond the two D101 receivers). The idea doc itself places the decision "at a milestone-planning moment (likely alongside M7 MCP scoping)"; its gate note confirms no M3/M4 sequencing change. Packet 15 asks for the out-loud confirmation.
- **M5** — traces/diff, explore, dashboards persistence (the workspace-store magnet — reaffirmed at every gate since S1), infra, map, services, users, costs analytics. **M5-GATE D32** — the `infra` producer rule stands.
- **M6** — alerts/oncall/SLOs/incidents/issues/changes. Note the trap packet 7 must respect: a `/status` page "fed by SLOs" is the current mock's fiction (`status/page.tsx:5`) — amendment 6 deliberately specifies **no bespoke status backend**; SLOs are M6.
- **M7** — ask, evals, security/redaction, MCP, pipelines, SSO/SAML, SOC2.

---

## 5. Advisor decision packet

Fifteen decidable items. **Items 1–3 block breakdown of the whole phase; item 4 blocks S4.1's; item 6 blocks S4.3's. Five blocking.**

1. **The S4 split. (BLOCKS BREAKDOWN)** §3 writes out A (1 sprint), B (2) and C (3, PM recommendation) against §2's now-eleven-run calibration. Sub-question: ratify the S4.1→S4.2→S4.3 sequence (D94 precedent: every run sequential) or free S4.3's ordering.

2. **The `web` image and the build-mode seam. (BLOCKS BREAKDOWN)** Nothing about the image is designed anywhere. Decidable sub-questions:
   - **(a) Build shape.** Next standalone (`output: "standalone"`) is the assumed form (vision line 62 names it) — but the repo is an npm workspace (`package.json:4-7`) with the SDK packages as members, and the two existing root-context Dockerfiles (`demo/sdk-sample-*`) already show the monorepo-build pattern this image will need. Turbopack root is set two levels up (`next.config.ts:5-8`).
   - **(b) The mode-stamp mechanism** (L6/D157 at raised stakes): how the artifact records its build mode and how a mismatched serve refuses. Interacts with #4 (S1 T12): the SAMPLE badge's env is read at build today — M4 re-decides "runtime env read or forced-dynamic shell" once, for both.
   - **(c) The compose posture.** Compose deliberately excludes web today with the auth-secrets rationale stated in the file (`docker-compose.yml:38-42`). The self-hosted bundle reverses that: the web container now *is* the process that signs cookies. Decide the secret-provision story for compose (env-file? generated?) and whether `web` is default-profile or a named profile.
   - **(d) The same-images constraint vs the cloud web tier.** PRD line 28: "cloud and self-hosted run the **same images** from the same repo… a day-one architectural constraint." The user's hosting direction (idea doc, 2026-08-20) points the web tier at Vercel — which builds from source and does **not** run this Docker image. If S5 lands there, cloud-web violates the constraint's letter for the web tier while ingest/ClickHouse/Postgres keep it. PM position: this is a real tension between a PRD hard constraint and a user hosting direction; **the advisor owns the technical posture (what "same images" binds after M4), the user owns the provider (U10)** — and S4.1 must know the answer only insofar as it decides whether the web image is the *only* sanctioned serve path or one of two.

3. **The retention-TTL mechanism. (BLOCKS BREAKDOWN)** D105's own text records why this is hard: "per-tier TTL on shared tables cannot be a table-level TTL clause." The tables are `PARTITION BY toDate(...)` with a flat 30-day TTL; the tier lives in Postgres (`plans.retention_days`: 7/30/90 per PRD §10). Options the PM can see, flagged not chosen:
   - **(a) Per-row TTL expression over a stamped column** — ingest stamps each row with its workspace's retention at write time (through the existing workspace-state cache); the TTL clause reads the column. Consequence: plan changes don't retro-apply to already-written rows (upgrade under-delivers on old data, downgrade over-delivers) — a product-truth question D13 cares about; requires a schema migration on all three tables plus the MV.
   - **(b) A scheduled delete job** — periodic `ALTER TABLE … DELETE WHERE` per workspace past its tier, driven from Postgres. Consequence: obstack has **no scheduler component** — inventing one is the M6 alert-evaluation shape arriving early; if it rides ingest (which already has boot-time migration machinery and a metering flush loop), it is an ingest responsibility with mutation rights, a posture change worth ruling explicitly. ClickHouse lightweight/mutation delete semantics are a measured question at breakdown (S2.4 L1 — no ruling on believed semantics).
   - **(c) Hybrid**: keep the 90-day table TTL as the outer bound; per-tier enforcement via (a) or (b) inside it.
   - Whichever is ruled, D105 binds the disclaimer removal to the same sprint, and the exit evidence must show both deletion past the tier and retention inside it.

4. **The chart's self-hosted surface — how much is S4-exit-required. (BLOCKS S4.1 BREAKDOWN)** D35 enumerates the surface (ingress/TLS, sizing, secret backend, self-hosted values, managed-Postgres values); the chart README pre-commits the StatefulSet+PVC move; D123 adds the rotation story; D119 adds `BETTER_AUTH_URL` to values. The PM cannot size "a secret backend selection" — options run from "values accept existing Secret names" (cheap, honest) to external-secrets integration (a component). Rule the exit-required floor; everything above it is S5-informed follow-up.

5. **Receiver design + the honest-build problem.** The Vercel drain speaks Vercel's own JSON schema to an HTTPS endpoint; CloudWatch needs a subscription-filter destination plus a forwarder artifact (a Lambda in the standard pattern — a deployable artifact in *someone else's* AWS account, a first for this repo). S4 builds both without a public endpoint to activate against (D101's own ground). Decidable: where the drain receiver lives (a new listener on ingest? the existing OTLP HTTP mux?), what the forwarder artifact is (SAM/Terraform/zip?), what CI proves (local POSTs of captured fixture payloads — the S2.2 L1 bar met with real requests), and the correlation posture for drain-delivered logs (they carry no trace context unless extractable — the idea doc's honesty constraint, decided here for these two receivers only).

6. **Docs architecture. (BLOCKS S4.3 BREAKDOWN)** Amendment 6 fixes the constraint: the docs site and in-app docs share **one content source**, `/changelog` is "static, release-note driven, part of the docs pipeline." Nothing names the tooling. Decidable: in-repo (a route group in `apps/web` over tracked MDX/MD — no new app, ships inside the web image, but couples docs deploys to app deploys) vs a separate static site (new workspace member; a second build artifact for S5 to host). The in-app surface's current corpus (`mock/docs.ts` — fictional Loopwork runbooks typed `DocArticle`/`DocBlock`) needs a ruled disposition: replaced by the real content source, or retained as labelled sample data in mock mode only (the D125/D208 seam: demo data vs product claim).

7. **`/status` shape.** Amendment 6: external uptime monitor + manually curated incident notices, **no bespoke status backend**. Today's page is a seeded-PRNG fabrication branded as Loopwork's SLO-fed page (`status/page.tsx:5,14-38,51-53`) — which is also an M6 fiction (SLOs). Decidable: what S4.3 builds (the real page shell + incident-notice content path, monitor embed/API wired at S5), and the Loopwork demo's disposition (it is currently honest-as-demo per its own footer; does it survive anywhere as a "what your customers would see" showcase, or is that an M6 surface?).

8. **The landing launch pass — enumerate the fence.** M3's fence was exactly "CTA block + demo sentence + pricing copy truth" (D106). M4 owns the page. Named items the PM can see: the `:547` "prototype — all data fictional" footer; nav gains Docs and Status links (`:56-59` has neither); the pricing block is hand-restated copy with a D226 comment saying so (`:397-405`) — does it start reading the `plans` catalog, or stay copy with a truth check; the waitlist block's post-launch role (signup is live — does the waitlist survive, convert, or go); the comparison table's claims re-verified. Ask for the complete enumeration at breakdown (S1 lesson 2: unenumerated surfaces leak fiction).

9. **The `ai@7` owner — the obligation is due.** D101: "a pre-registered M4-PLANNING item with a **named-owner obligation there**." Options: an S4 sprint ships the `AI_SDK_TELEMETRY_INTEGRATIONS` integration in `obstack-js` (D78: additive or it escalates); or it is deferred past M4 with a named milestone and the quickstart keeps stating the `ai@^6` fence honestly. PM note: `ai@7` users meeting the quickstart is a launch-audience question, which is why the naming cannot slide again.

10. **D103(a) — JS logging bridge / streaming instrumentation / Responses API.** "Revisited with launch-polish scope" is this moment. In (which sprint?) or out (stated absence in the docs S4.3 writes — the docs site makes every absence user-visible, so the honest-absence sentences must be written either way).

11. **D218 — windowed rate.** A counter-schema change on the D100 mechanism. In (S4.2 is the natural home — same rows, same flush) or carried again with the cumulative+as-of presentation the signed deviation already covers.

12. **The CI surface.** Image builds need CI (the S4 exit is "a clean checkout produces the images") — new stable job name(s) under K3, priced against K5's ~6-minute line; the docs build joins per the exit line ("docs/status/changelog content builds"); the lint question (#17: 6 recorded eslint errors, no lint job — "M4's CI surface is the natural home") is decided, not re-deferred; `e2e` enters S4 at ~10s of headroom with D207 pre-authorized — state whether S4 sprints may consume the reclaim or must return first; D132/D153 get named owners or explicit deferrals.

13. **The public demo — what is it, concretely.** PRD §13 names "public demo environment" as a Phase-4 deliverable; vision line 62 says S4 *builds* it, line 70 says S5 *ships* it. Today "the demo" is the mock-mode walkthrough at `/app` (landing CTA "Open the live demo"). Decidable: the demo environment's form — (a) a mock-mode build of the web app served publicly (cheap; the L6 mode-stamp makes it safely serveable *as* mock for the first time); (b) a live-mode instance with a seeded demo workspace fed by the demo app (true product, real cost, needs auth bypass or a shared read-only session — new surface); (c) both, staged. This decides real S4 work (what artifact exists) and S5 work (what gets hosted).

14. **`Writer.Close` mechanics.** Rule the shape: `Close(ctx)` honoring the shutdown deadline through both batchers, `terminationGracePeriodSeconds` set explicitly in the chart with the 10s app deadline inside it, and the flush-loss posture on deadline overrun stated (drops counted, never silent). Cited state: `main.go:271-295` (10s ctx exists, not passed), `write.go:145-151`, `batcher.go:83-93,128,143-147`.

15. **The out-loud no's.** (a) The two idea-doc items stay out of M4 (their own text agrees); confirm their decision moment (M7 planning per the idea doc, or a dedicated milestone-planning round earlier if the user pulls it). (b) The non-OTLP receiver families beyond Vercel+CloudWatch stay out. (c) Dashboards persistence stays M5 despite S4 touching every deploy artifact. (d) D180's gate does not fire unless packet 3's mechanism creates a workspace-deletion surface.

---

## 6. Pre-registered USER decisions

**Status: OPEN — written for the user round. None of these block S4 breakdown; U10 and U11 block S5 sequencing** (vision Questions item 3, standing since the founding doc). The idea doc's 2026-08-20 notes are decision *input*, recorded there by the user — not decisions.

### U10 — Hosting/provider for the cloud SaaS, docs site and public demo (BLOCKS S5)
The user's own recorded direction: buy a domain, point it at the Vercel deployment for the web tier (`app.<domain>` → Vercel, `ingest.<domain>` → ingest host — the D101 public HTTPS endpoint the connectors need); options under consideration: **A — Railway for everything** (~1:1 from compose, keeps same-images honest for all four pieces, single-node ClickHouse on a volume, est. $50–150/mo) vs **B — GCP + Google-for-Startups credits** (Cloud Run + Cloud SQL + GCE ClickHouse; credits tiered ~$2k/$200k/$350k with eligibility conditions; credit-expiry cliff; more ops), with the portability guard (nothing provider-proprietary) and the lean "apply for GCP credits regardless; ≥$25k → GCP, else Railway." **PM adds the §5 packet-2(d) fact for the decision:** Vercel-for-web means the cloud web tier does not run the S4 web image — the same-images constraint holds fully only under a container host for web. The advisor's posture ruling (packet 2d) and this choice should land together.

### U11 — Domain (BLOCKS S5)
Deferred from U7 under U1=local. Purchase and naming are the user's. Until owned, no copy asserts one (D101's rule: the quickstart renders the environment's real endpoint).

### U12 — External uptime monitor behind `/status`
Amendment 6 requires one and the vision doc explicitly leaves it the user's (line 70). An account under the user's identity; S4.3 builds the page to receive it, S5 wires it.

### U13 — Design partners
The S5 exit is "first 5 design partners activated." Recruiting is a user act (PRD §11: "recruited directly from AI-startup networks"). Flagged now because it has the longest lead time of anything in M4 and can run in parallel with all of S4.

### U14 — Polar production promotion prerequisites
The S5-GATE flip is a production promotion under the user's Polar account (organization verification, production tokens, webhook endpoint config — the D177 inventory + D200 consequence). The account-side prerequisites are the user's to start; the checklist is S5's.

### U15 — Email at launch
U4 ruled no email in M3 (invites = copyable links) and moved the provider decision to S5. Decide at S5: does public launch ship without email (defensible; stated), or does a provider land with hosting? better-auth keeps verification additive (D95(c)).

### U16 — GCP credits application
The idea doc's own lean: apply regardless (application-only cost), decide on the landed amount. A user act, start-anytime.

---

## 7. Coverage check (2026-08-23)

The S4 build-half exit + amendment 6 + the §4 ledger, decomposed. Owners under Option C.

| # | condition | source | owner | status |
|---|---|---|---|---|
| F1 | a clean checkout produces the `web` image | vision 62 | S4.1 | covered — **design open (packet 2)** |
| F2 | a clean checkout produces the `ingest` image | vision 62 | S4.1 | **already true** (`services/ingest/Dockerfile`) — S4.1 re-verifies in the bundle context |
| F3 | compose boots the full stack from those images | vision 62 | S4.1 | covered — **secret posture open (packet 2c)** |
| F4 | the chart boots the full stack from those images, extended in place | vision 62; D35 | S4.1 | covered — **surface depth open (packet 4)** |
| F5 | tier TTLs applied on the D7 tables; disclaimer removed same sprint | vision 62; D105 | S4.2 | covered — **mechanism open (packet 3)** |
| F6 | docs content builds; docs site is quickstart-first | vision 62; PRD §11 | S4.3 | covered — **architecture open (packet 6)** |
| F7 | in-app docs render the same content source | amendment 6 | S4.3 | covered — mock-corpus disposition open (packet 6) |
| F8 | `/status` = external monitor + curated incidents, no bespoke backend | amendment 6 | S4.3 build / S5 wire | covered — **monitor is U12** |
| F9 | `/changelog` static, release-note driven, in the docs pipeline | amendment 6 | S4.3 | covered |
| F10 | landing final launch pass | amendment 6 | S4.3 | covered — **fence enumeration at breakdown (packet 8)** |
| F11 | Vercel + CloudWatch receivers built and CI-exercised | D101 | S4.2 | covered — **design open (packet 5)** |
| F12 | build-env enforcement lands (L6/D157, raised stakes) | ledger #3 | S4.1 | covered |
| F13 | `Writer.Close` bounded inside chart grace | ledger #5 | S4.1 | covered |
| F14 | `ai@7` owner named | D101 obligation | packet 9 | **unowned until the packet rules** |
| F15 | D103(a)/D218/D132/D153/lint each named-in or stated-out | ledger #8,9,13,14,17 | packets 10–12 | **unowned until the packet rules** |
| F16 | the public demo environment is built (S4) and shipped (S5) | PRD §13; vision 62,70 | packet 13 → owner | **GAP — the demo's form is undefined anywhere in the record** |
| F17 | S5: SaaS + demo + docs live, `/signup` publicly reachable, Polar production, 5 design partners activated | vision 70; §4 #21 | S5 | covered — **blocked on U10/U11** |

### Standing checks
- Every milestone → ≥1 sprint: M4 → S4.x + S5. PASS.
- Every deployment impact → a deploy sprint: all deployment in S5. PASS.
- Every product surface → an owning milestone: M4 newly owns `/` (final pass), `/status`, `/changelog`, docs site, in-app docs per amendment 6; no M5/M6/M7 surface pulled forward (the `/status` SLO fiction is *removed*, not implemented — packet 7). PASS.
- Every acceptance criterion → an owner: F1–F17; F16 is a recorded gap, F14/F15 are packet acts. PASS with 1 gap + 2 naming acts.

### Gaps, recorded honestly
1. **F16 — "public demo environment" has no definition anywhere in the record.** Packet 13 creates one.
2. **The split is undecided**, so §4's owner columns are provisional.
3. **S5 remains structurally unplannable** until U10/U11 — the same posture the record has held since 2026-08-15, now load-bearing.
4. **This plan has no task breakdown, by design** (D20). It returns to the advisor first.

---

## 8. Open questions and risks — grounded in the code

Verified 2026-08-23 on `a11ae7a`.

- **The web image is greenfield in a repo with strong container precedent.** Five Dockerfiles exist; none for web; `next.config.ts` lacks `output: "standalone"`; the sdk-sample images already solved root-context monorepo builds (`demo/sdk-sample-ts/Dockerfile` `npm pack`s the workspace package). The npm-workspace layout and the Turbopack root setting are the two things a standalone build must get right.
- **Compose excludes web *on purpose*, with the reason in the file** (`docker-compose.yml:38-42` — auth secrets belong to the cookie-signing process). S4.1 reverses a documented decision; the reversal must answer the reason, not just delete the comment.
- **The chart's own README is a pre-commitment list** (`deploy/helm/obstack/README.md:36-55`): no second chart; M4 replaces both hostPath Deployments with StatefulSets+PVCs; TTL tiers/docs/self-hosted values named out-of-scope-until-M4. Zero Secret/Ingress/PVC/resources objects exist today — the values surface is written from nothing.
- **The flat 30-day TTL is currently *wrong in both directions* for a tiered product**: free (7d) is over-retained (D105 says so honestly), Scale (90d) would be **under-retained the moment a 90-day workspace exists** — data deleted at 30d that the plan sold at 90d, a D13-class breach no disclaimer covers. Packet 3's mechanism must fix both directions; the exit evidence must prove both.
- **`ingest-endpoint.ts` hardcodes `127.0.0.1` with a comment naming M4** (`:21` "a deployment that publishes ingest elsewhere is the self-hosted surface M4 builds"). The D214/D221 K8s card boundary and the connectors' external story all route through this one module — S4.1's endpoint-configurability change touches quickstart, connect flows, and the drive.
- **`/status` and `/changelog` are live routes serving fiction and hardcode respectively** — `status/page.tsx` generates 90 days of uptime from a seeded PRNG and brands itself Loopwork; `changelog/page.tsx` holds its four entries in the page file (already honesty-passed by D229/D246, so the *content* is true; the *pipeline* is the M4 work).
- **There is no docs content anywhere** — `docs/` at root holds screenshots and the two PRDs; the only in-app docs are the fictional Loopwork runbooks in `mock/docs.ts`. S4.3 writes the entire corpus from zero; the quickstart (S3.4, D78-verbatim) is the only existing true documentation in the product.
- **`Writer.Close` cannot honor a deadline today** — the 10s `shutdownCtx` exists (`main.go:278`) and is not passed to `Close()` (`:287`); each batcher's `close()` blocks unbounded (`batcher.go:143-147`). Under Kubernetes rolling updates this is the exact seam the S1 deferral named.
- **CI is one job from its ceiling.** `e2e` at 5m47–50s against the ~6m K5 line with the D207 reclaim pre-authorized but unconsumed; S4 adds image builds and a docs build to the surface. New jobs get forever-names (K3) and their trigger policy comes from first real-runner numbers (D93/S2.4 L3), not local ones.
- **Repo hygiene is now product surface**: a distributable clean-checkout build meets the stray root files (`src/app/` empty dir, root `.next/`, `test-output.log`, `tsconfig.tsbuildinfo`, `pitchdeck-assets/`) and `apps/web`'s checked-in-tree `.next/`. Cheap to fix; embarrassing to ship; belongs to whichever sprint packet 12 assigns the CI/build surface.
- **The Vercel-for-web direction and PRD line 28 genuinely conflict for one tier** (packet 2d / U10). Neither this plan nor the advisor can dissolve it: it is a constraint-vs-preference call, and it should be made before S4.1 finalizes what "the sanctioned serve path" means.

---

## 9. Advisor rulings (D250–D264, 2026-08-23) — BINDING

The advisor verified every load-bearing code citation in this plan against `m4-planning` @ `a11ae7a` before ruling — code, planning records, vision doc lines 54–70, PRD lines 26–28 and the §13 Phase-4 row (line 171), the milestone bundle's gate inventory (lines 20–25), and the idea doc's hosting notes (lines 49–55) — and returns: **the plan's evidence is sound.** This section supersedes §3's provisional sprint IDs and, where they differ, §4's owner columns and §7's owners.

**Four imprecisions corrected for the record, none void-making:**
- (i) **"`batcher.go:143-147` blocks unbounded" is wrong in letter, right in force.** `send()` is bounded: `maxAttempts = 3` × `writeTimeout = 30s` + backoff 250ms+500ms (`batcher.go:15-17,108-125`) ≈ **90.75s worst case per batcher, ~181.5s for both sequentially in `Close()`** — bounded, but ~18× the 10s `shutdownCtx` (`main.go:278`) which is never passed (`main.go:287`). The defect is **coordination, not unboundedness**; D263 rules on the corrected fact and the decision is unchanged.
- (ii) §8's "Five Dockerfiles exist" — **four** (`services/ingest`, `demo/agent-app`, `demo/sdk-sample-py`, `demo/sdk-sample-ts`) plus two `Dockerfile.dockerignore` files.
- (iii) Packet 3's "`plans.retention_days`: 7/30/90 per PRD §10" describes the **PRD**, not the seed: `0005_metering.sql:125-126` seeds only `free=7` and `pro=30`; Scale has no catalog row (the landing's own D226 comment at `page.tsx:397-405` says so). The 90-day under-retention breach is **conditional on a Scale row landing** — exactly as §8 states it; §3 foundation-fact 3 reads with that precision.
- (iv) Root `package.json` `workspaces` spans lines 5–8, not 4–7. Trivial.

All other citations exact as cited: `next.config.ts:1-11` (no `output` key; Turbopack root at `:5-8`), `docker-compose.yml:38-42` verbatim, `values.yaml:1-8` fence verbatim, chart `README.md:36-55` with the StatefulSet+PVC pre-commitment at `:50-51`, TTL lines `0001:46`/`0002:35`/`0003:42` all `INTERVAL 30 DAY`, `SettingsSuite.tsx:726` disclaimer sentence live, `status/page.tsx:5,14-38,51-53` (seeded `mulberry32`, Loopwork branding, "powered by obstack SLOs"), `changelog/page.tsx:17-45` hardcoded, `connectors.ts:~124-145` SOON cards with the D101/D208 comment, `ingest-endpoint.ts:15-31` hardcoded loopback with the M4 comment, landing `:55-59` nav (no Docs, no Status), `:397-405` D226 comment, `:547` prototype footer, all six stray hygiene files present, `demo/sdk-sample-ts/Dockerfile` root-context `npm pack` pattern confirmed.

### D250 (packet 1) — Split: Option C RATIFIED and EXTENDED to four dev sprints; sequential S4.1 → S4.2 → S4.3 → S4.4 → S5

Option C's grounds are the D28/D94 grounds on now-eleven runs: the only overruns batched areas; A and B both batch. **Ratified.** One correction, forced by D258: the `ai@7` obligation lands as its own sprint (an obstack-js integration is not "ingest launch hardening" and not "content" — batching it anywhere in C recreates the shape C exists to avoid), and it lands **before** the content sprint so the docs corpus is written once against the final SDK truth. Final IDs:

| final id | sprint | was | absorbs |
|---|---|---|---|
| **S4.1** | the distributable artifact | C1 | D251 image+seam, D253 chart floor, D263 Close, D261 lint/hygiene/D132, D214 endpoint half, D123, D262's mock-build variant |
| **S4.2** | ingest launch hardening: retention + receivers | C2 | D252 TTL mechanism + D105 disclaimer, D254 receivers, D260 windowed rate |
| **S4.3** | obstack-js launch alignment: `ai@7` | — (new) | D258 `ai@7` integration, D259 D103(a) triage, D178 standing check |
| **S4.4** | docs, status, changelog, landing | C3 | D255 docs, D256 status, D257 landing, honest-absence sentences from D259 |

**Sequential dispatch in that order — the "free S4.3's ordering" latitude is REFUSED**: every closed run on this project was sequential, and the content sprint documenting artifacts that do not yet exist is the fiction-manufacturing shape D13 exists to prevent. Each sprint lands demoable per D20 (S4.1: "clone, build, `helm install`, sign up on your own cluster"; S4.2: "free's 7 days is real, a drain POST lands logs"; S4.3: "an `ai@7` sample produces the four-layer trace"; S4.4: "read the docs and everything they say is true"). No D34 tension: the vision writes the build-half exit (line 62) and milestone exit (line 70) separately.

**§4 owner columns: RATIFIED with these renumberings/corrections** — row 7 → S4.3 (D258); row 8 → S4.3 triage, S4.4 sentences (D259); row 9 → S4.2 IN (D260); row 13 → S4.1 (D261); row 14 → explicit deferral, M5-planning packet (D261); row 17 → S4.1 (D261); row 16 → gate does not fire (D264d); row 12 → S4.1 documents / S5 provisions, with `BLOB_READ_WRITE_TOKEN` EXITING the inventory when D257 removes the waitlist. All other rows ratified as written.

**§7 owners: CONFIRMED with renumbering** — F6–F10 → S4.4; F14 → S4.3 (owner now named, gap closed); F15 → per D259/D260/D261 (all named, gap closed); F16 → **closed by D262**: the demo artifact is S4.1's mock-mode image variant, hosted at S5. No remaining coverage gap except U10/U11 blocking S5, which is the standing posture.

### D251 (packet 2) — Web image: standalone, root-context, one Dockerfile; mode-stamped artifact that refuses mismatched serve; web joins compose default profile with a no-default auth secret; same-images posture defined

- **(a) Build shape:** `output: "standalone"` added to `next.config.ts`; **one multi-stage Dockerfile at `apps/web/Dockerfile` with the build context at the repository ROOT** — the repo is an npm workspace and the sdk-sample images already prove the root-context pattern; a `Dockerfile.dockerignore` scopes the context (same discipline, measured size stated in the sprint bundle). Base image exact-pinned (D14). **S2.4 L1 binds: this Next version is nonstandard (AGENTS.md's own warning) — the exact standalone output layout, static/public copy steps, and MDX wiring are read from the vendored docs at `node_modules/next/dist/docs/` at breakdown, cited by file in the task plan. No step is written from training-data memory.**
- **(b) Mode stamp — one mechanism for L6/D157 and S1 T12, decided once:** the artifact is **single-mode**. The build bakes `OBSTACK_DATA_MODE` into a stamp the artifact carries; at server boot a startup check (the instrumentation/boot hook — exact location per the vendored docs) compares the stamp against the runtime environment and a mismatch **refuses to start, loudly, naming both values** — proven red-then-green in CI (the D96 tripwire treatment; the stakes are "costs signup entirely"). **S1 T12 resolves as: the badge keeps its build-time env read** — correct by construction once the artifact is single-mode and mismatched serve is impossible; no forced-dynamic shell. **The S1 cached-prerender repro closes structurally for images** (Docker builds are clean-context); the `rm -rf .next` rule remains binding only for host-local matrix checks and is encoded in the CI matrix steps, not left as lore.
- **(c) Compose posture:** `web` joins the **default profile** — the exit line is "`docker compose up` boots the full stack." The `docker-compose.yml:38-42` rationale is **answered, not deleted**: the web container is now the process that signs cookies, so the secrets move to it. **`BETTER_AUTH_SECRET` gets NO baked default** — `${OBSTACK_BETTER_AUTH_SECRET:?...}` required-var syntax so an unset secret fails fast with a generate instruction (`.env.example` ships beside the file). Ground: the loopback-scoped DB dev passwords are defensible defaults; a committed cookie-signing secret in a distributable bundle is a shipped vulnerability. `BETTER_AUTH_URL` defaults to the local loopback origin with the D119 http-downgrade consequence documented at the value.
- **(d) Same-images posture (the advisor-owned half; U10 stays the user's):** "same images" binds, from M4 on, as **same source, same commit, same build configuration for every sanctioned serve path; ingest, ClickHouse and Postgres keep the letter absolutely; the web image is the only sanctioned containerized serve and the only self-hosted serve.** If U10 lands on Vercel for the cloud web tier, that is a **second sanctioned serve path of the same source at the same commit**, the PRD line-28 letter is recorded as a **user-owned deviation of record for the cloud web tier only** (D31/U3 class — the PRD is never edited), and the D251(b) refusal mechanism **must bind on that path too** (the Vercel build is live-mode-stamped like any other). S4.1 builds the image unconditionally — self-hosted requires it under every U10 outcome — so **S4.1 is not blocked on U10**.

### D252 (packet 3) — Retention: hybrid (c) — outer table TTL at the PRD §10 maximum, per-tier enforcement by a fixed-cadence retention sweep in ingest; retro-applies both directions; delete semantics measured at breakdown

- **Per-row stamped TTL (a) REFUSED as the enforcement mechanism** on D13 grounds: it freezes each row's retention at write time, so an upgrade does not extend retention of already-written data — a user who pays for 30 days and finds last week's rows expiring on the free schedule has been under-delivered against the pricing page. The honest mechanism reads the **current** plan.
- **Ruled: (b)-inside-(c).** The three table-level TTLs move (tracked ClickHouse migration, existing runner) from 30 days to **90 days — the PRD §10 maximum tier — as the outer safety bound**; per-tier truth is a **retention sweep in ingest**: a fixed-cadence loop (daily grain — TTL granularity is days; the cadence is a stated constant) reading `plans.retention_days` per workspace from Postgres (**direct read, cold path — the D98/D99 workspace-state cache is a hot-path artifact and is not coupled to this**; absent plan row = free per D163) and issuing per-workspace deletes past the cutoff on `spans`, `logs`, `trace_summaries`.
- **Posture ruled explicitly, as the PM asked:** the sweep is an **ingest responsibility with ClickHouse mutation rights** — ingest already owns both stores' DDL and already runs the D99/D100 flush loops; this is the established loop shape, not a new component. **It is NOT the M6 alert-evaluation engine arriving early**: one fixed cadence, one query shape, zero user-configured schedules, zero notifications. The fence is written into the sprint plan.
- **S2.4 L1 binds:** lightweight `DELETE` vs `ALTER TABLE … DELETE` semantics, mutation cost against `toDate(...)` partitions, and behavior on the `AggregatingMergeTree` + MV pair are **measured at S4.2 breakdown**, results attached to the critical-item return. Retained semantic stated honestly: summaries expire on `max_seen_date`; a trace straddling the cutoff loses its older spans while its summary survives to its own expiry — the same semantic the flat TTL has today.
- **D105 binds:** the `SettingsSuite.tsx:726` disclaimer is removed **in the same change**, and the exit evidence proves **both directions** — rows past the tier deleted, rows inside the tier retained — for at least two different tiers. The interim over-delivery created by raising the outer TTL before the sweep lands within the same sprint is acceptable (over-delivery is the benign direction, per D105's own reasoning).
- **D180's gate does not fire** — the sweep deletes telemetry rows past retention, never workspaces (see D264d).

### D253 (packet 4) — Chart floor: StatefulSets+PVCs IN (the README's own pre-commitment), chart-owned Secrets with `existingSecret` override, optional Ingress for web AND ingest, resource values with stated defaults, managed-Postgres values, documented rotation; external-secrets REFUSED

Exit-required floor for S4.1, in place per D35 (never a second chart):

1. **`web` workload** (Deployment + Service), image exact-pinned, mode-stamp env wired, `BETTER_AUTH_URL` a required value with the D119 https posture documented at it.
2. **ClickHouse and Postgres move to StatefulSets + PVCs.** Not deferrable: the chart README pre-committed M4 by name (`README.md:50-51` — "rather than inheriting them silently"); deferring now is the silent inheritance it forbade.
3. **Secrets: the standard pattern and nothing more** — chart renders its own Secret from values by default; every credential (Postgres password, both ClickHouse passwords, `BETTER_AUTH_SECRET`, optional `OBSTACK_EXPLAIN_API_KEY`) accepts an `existingSecret` name override. **External-secrets integration REFUSED — a component, speculative.** Polar values do NOT enter the chart: self-hosted is "same product minus managed billing" (PRD line 27).
4. **Ingress: optional templates for web and for ingest OTLP/HTTP**, host + TLS-secret values, annotation pass-through; **no controller and no cert-manager shipped**. Ingest's ingress is exit-required because it **is** the D214 network-reachable self-hosted surface — the reason `connectors.ts:90`'s K8s card and `ingest-endpoint.ts`'s M4 comment both point here.
5. **Resource requests/limits values with conservative stated defaults.** HA beyond ingest's existing replica story is NOT exit-required.
6. **Managed-Postgres values** (external DSN/host + `existingSecret`, disabling the in-chart Postgres) — cheap conditional, D35 enumerates it, IN.
7. **D123 rotation: a documented procedure in the chart README** (update Secret → in-DB `ALTER USER` → roll), not automation.

Above the floor — autoscaling, PDBs, NetworkPolicies, multi-replica ClickHouse, backup automation — is **S5-informed follow-up, named OUT here**. The ingest one-runner rule keeps its existing pre-upgrade Job shape (D95(a)).

### D254 (packet 5) — Receivers: both are routes on the existing ingest HTTP mux behind the D98 bearer path; the CloudWatch forwarder is a dependency-free single-file Lambda relay; no SAM/Terraform; no invented correlation; payload schemas measured at breakdown

- **Placement: no new listener.** Both receivers are routes on the existing OTLP HTTP mux (shape: `/v1/integrations/vercel`, `/v1/integrations/cloudwatch` — final paths at breakdown), authenticated by the same `Authorization: Bearer` key resolution (D98 cache), mapping into the existing log write path — **metering (D99), health rows (D100), drop counters and quota degradation all ride free.** A second listener is a second port to publish, secure, and document, for nothing.
- **The mapping lives in Go, in-repo, where our tests are.** The **CloudWatch forwarder is a minimal decode-and-relay**: one dependency-free Node.js handler file under `deploy/` that base64+gunzips the `awslogs` envelope and POSTs it to the ingest route with the key. **SAM and Terraform REFUSED** — a toolchain for someone else's AWS account is invented scope; the artifact is the handler + a CI-produced zip + documented `aws` CLI setup steps. CI proves the zip packages and the handler, invoked in a plain node harness against captured fixture payloads, lands rows in a local ingest.
- **S2.4 L1 — measured at S4.2 breakdown, never believed:** the Vercel drain delivery format and its endpoint-verification handshake; the CloudWatch subscription-filter `awslogs` envelope; fixture provenance recorded (captured real payloads, not hand-typed).
- **CI bar: S2.2 L1 is met by real local POSTs** of those fixtures through compose — activation claims wait for S5; **the SOON cards do not flip (D101/D208)** and the hub copy stays "Coming soon" verbatim until S5 activates against the public endpoint.
- **Correlation posture for these two receivers, ruled here only:** extract trace context **only from measured payload fields that actually carry it**; everything else lands trace-less and joins as the nearby class (D37 window). **No inferred correlation, ever** — stated in the docs S4.4 writes.

### D255 (packet 6) — Docs: in-repo route group in `apps/web` over tracked MDX; one renderer IS the one content source; the Loopwork docs corpus is DELETED, not retained

- **Ruled: in-repo.** A docs route group in `apps/web` over a tracked MDX content tree (location at breakdown; first-party MDX support per the **vendored** Next docs — AGENTS.md's warning applies, breakdown-time read). Amendment 6's "same content source" is satisfied **by identity**: the docs site and the in-app docs are the same renderer over the same files. The docs ship inside the web image; "docs content builds" = the web build compiles the content, so **a content failure fails the build — no separate docs CI job exists** (see D261). A separate static site REFUSED: second artifact, second toolchain, second renderer to keep honest, for zero current requirement. Docs-deploy-coupled-to-app-deploy is correct at this team size — docs change with the product; versioned docs are a post-v1 concern, not built speculatively.
- **`/changelog` joins the same pipeline**: entries become release-note files in the content tree; the four true entries (`changelog/page.tsx:17-45`, already D229/D246-passed) migrate **verbatim**. The D246 sweep's coverage of this content **must survive the file move** — a named done-check.
- **`mock/docs.ts` is DELETED with its render paths.** Docs are product chrome, not workspace demo data — there is no "sample docs" concept on the D125/D208 seam. An in-app docs surface rendering fictional Loopwork runbooks once real docs exist is the S2.2 L1 lie class. Both modes render the real corpus.
- **Quickstart-first (PRD §11)**; the corpus documents: signup, quickstart (D78-verbatim strings — the S3.4 byte-level check re-runs against the docs copies), self-hosted bundle (compose + chart), connectors (including the two receivers' honest "coming soon at launch" state until S5), Explain, billing, and the honest-absence sentences D259 produces.

### D256 (packet 7) — `/status`: the route becomes obstack's own page — shell + curated incident content path in S4.4, monitor wired at S5; the Loopwork status fiction is DELETED with no relocation

- S4.4 builds: obstack's real status page — component list (app, ingest, docs), **incident notices as curated files in the D255 content tree** (the "manually curated" of amendment 6 — no bespoke backend), and a monitor panel slot that, until S5 wires U12's monitor, **states plainly that external monitoring begins at launch** — no fabricated uptime, no placeholder numbers. The concrete embed/API integration is shaped at S5 by U12's choice; building against an unchosen monitor's API now would be believed-not-measured.
- **The Loopwork demo status page is DELETED, not relocated.** Its own header claims "powered by obstack SLOs" (`status/page.tsx:5,52`) — an obstack capability that does not exist and is M6's; a "what your customers would see" showcase is an M6 surface **if** SLOs ever ship one. S2.2 L1 and D13 both bar keeping it anywhere reachable.

### D257 (packet 8) — Landing: footer sentence removed; nav gains Docs + Status; pricing stays copy UPGRADED to a mirror-tested truth; the waitlist is REMOVED; complete fence enumeration at breakdown is a critical item

- **`page.tsx:547` "prototype — all data on this site is fictional" is removed in S4.4** — it stops being true when the content surfaces go real; per-surface honesty is carried by the existing D125/D208 labelling, which is the correct grain.
- **Nav gains Docs and Status links** (`:55-59`), sequenced inside S4.4 after those surfaces exist.
- **Pricing block stays copy — and the D226 "verified true at review" posture is upgraded to a test**: a mirror test comparing the landing's stated numbers against the `plans` seed, the exact pattern `ingest-endpoint.test.ts` and the D206 `FLUSH_MS` mirror already use ("a comment naming a source is not a check"). Reading Postgres from the landing at render time REFUSED — the page renders in both modes and mock mode has no Postgres.
- **The waitlist block is REMOVED in S4.4** — signup is the product's front door; the change reaches the public only when S5 deploys. Consequence recorded: `BLOB_READ_WRITE_TOKEN` **exits the hosted env inventory** (§4 row 12 corrected); the collected entries' disposition is the user's (see user round).
- **Comparison-table claims re-verified line-by-line** inside the sweep. **S1 lesson 2 binds: the complete surface enumeration is produced at S4.4 breakdown and returns to me as a critical item** — the four named items above are the floor, not the fence.

### D258 (packet 9) — `ai@7`: owner NAMED — the S4.3 sprint (dev-team) ships the integration in `obstack-js`; D78 governs; escalation path pre-registered

The obligation is due and is discharged by naming a **shipping owner, not another deferral**: **S4.3 — obstack-js launch alignment** ships the `ai@7` integration on the `diagnostics_channel`/`AI_SDK_TELEMETRY_INTEGRATIONS` path, plus a sample-app leg proving the four-layer trace on `ai@7`, with the D178-class re-measure of the integration surface at breakdown. Ground: the quickstart's headline JS integration facing launch strangers on the **current** major of the most prominent JS AI framework, with D101 having pre-registered exactly this launch-audience concern — an honest "`ai@7` not supported" fence in the launch docs is honest, but it is a launch-quality cost the milestone named in advance and can afford one S2.4-half-class sprint to avoid. **D78's freeze governs: the integration must be additive; if breakdown-time measurement shows it cannot be, it ESCALATES to me before any API change** — that escape is the ruling's own clause, not a stopgap. Sequenced before S4.4 so the docs are written once against the final SDK truth (D250). The user may strike this sprint as a D31-class scope call — flagged in the user round with my recommendation to keep it.

### D259 (packet 10) — D103(a): Responses API IN-if-additive at S4.3; streaming instrumentation and the JS logging bridge OUT of M4 with honest absence in the S4.4 docs and a named M5-planning revisit

- **Responses API instrumentation: IN S4.3, conditional only on the D78 additivity check** — an OpenAI auto-instrumentation that misses OpenAI's current API shape fails its own product claim at launch. Size and mechanism are measured at S4.3 breakdown (S2.4 L1); if not additive, it escalates with the `ai@7` path.
- **Streaming instrumentation and the JS logging bridge: OUT of M4.** Neither is in any exit line, and the docs site makes their absence user-visible — so **the honest-absence sentences are written in S4.4 either way** (the D87 precedent), and the revisit is **named: the M5-planning packet carries both**. Not silent: stated in docs, owned at M5 planning.

### D260 (packet 11) — D218: IN, S4.2 — the windowed-rate counter schema lands on the D100 mechanism

The signed cumulative+`as_of` deviation was honest but pre-registered its own M4 revisit; S4.2 already owns ingest's Postgres write paths, so this is the one-touch moment — carrying it again means touching the same mechanism twice later. Shape: windowed buckets sufficient to render a **true** rate in the hub (the /min figure D218 refused to invent becomes computable); exact bucket grain at breakdown. The hub's rate display flips from as-of to windowed in the same sprint — one definition, no dual presentation.

### D261 (packet 12) — CI surface: new forever-names `images` and `lint`; docs build rides the web build; `stack`/`e2e` untouched in shape; D207 reclaim consumable on the watch firing, recorded, no return trip; D132 → S4.1; D153 → explicit M5-planning deferral; hygiene strays → S4.1

- **New stable job `images` (K3: forever):** builds the web image (live + mock variants — the D251(b)/D262 matrix), builds the ingest image, boots the compose bundle **from those images**, runs healthchecks + a smoke probe + the mode-mismatch refusal check. This is the "clean checkout produces the images" exit clause, priced in **one new job** so `stack` (5m04–12s) and `e2e` (5m47–50s) keep their recorded ranges and watches unpolluted — the D107 "stay separate" ground. Trigger policy per K5/D93/D137: **provisionally every-PR, confirmed or demoted on the first real-runner numbers, which return to me** (the D137 shape exactly).
- **No separate docs job**: per D255 the docs/status/changelog content compiles inside the web build — the existing `web` job and `images` both discharge "content builds."
- **`lint` (K3: forever): decided, not re-deferred — lands in S4.1**, with the **6 recorded eslint errors fixed in the same change**; a lint job born with carve-outs is a dishonest gate. Cheap against K5.
- **D207 reclaim:** pre-authorized means pre-authorized — **any S4 sprint may consume it the moment an `e2e` run crosses the ~6-minute line, no return trip, consumption recorded in that sprint's bundle**; anything beyond the reclaim (the over-branch) still requires the D137 three-consecutive watch and returns to me.
- **D132** (NoSessionError log volume): **S4.1**, small task — hosted ops meet real logs at S5; the noise is fixed before then.
- **D153** (expired-invitation reaper): **explicitly DEFERRED past M4; named owner: the M5-planning packet.** Ground: expired invites grant nothing — this is data hygiene, not launch truth; inventing a web-tier reaper inside a launch milestone is scope with no exit clause behind it. Out loud, not silent.
- **Repo hygiene → S4.1:** delete and gitignore the stray build artifacts (root `.next/`, empty `src/app/`, `test-output.log`, `tsconfig.tsbuildinfo`, `apps/web`'s checked-in `.next/`) — a distributable clean checkout is now product surface. `pitchdeck-assets/` is the user's content — disposition flagged in the user round, not ruled.

### D262 (packet 13) — The public demo IS the mock-mode build of the web image, served as the marketing site; a live seeded-workspace demo REFUSED

**Ruled: (a).** The demo of record is already the mock walkthrough at `/app` — deterministic, rich, zero marginal cost, no auth surface, no abuse surface — and D251(b)'s mode stamp makes a mock artifact **safely serveable for the first time** (it refuses to run as anything else). Option (b) invents an auth-bypass/shared-session surface — a security surface created for marketing, pre-launch — REFUSED as speculative and risk-adding; revisit only on design-partner evidence that the mock demo under-sells.

**Named topology consequence for S5 (closes F16):** the S4.1 image matrix produces **two variants of one Dockerfile at one commit** — live-stamped and mock-stamped. S5's public topology: the **app host serves the live build; the marketing host (landing + docs + status + changelog + `/app` demo) serves the mock build** — the demo ships free inside the marketing site. Cross-host CTA/link wiring is an S4.4 breakdown detail, named now. S4's "builds the demo" clause is discharged by S4.1 (the mock variant is a produced, CI-booted artifact); S5 hosts it.

### D263 (packet 14) — `Writer.Close(ctx)`: the shutdown deadline threads through both batchers; deadline overrun drops are counted, never silent; grace periods explicit in chart AND compose

Ruled shape, on the corrected fact from the preamble (bounded ~181.5s worst case, uncoordinated):

1. **`Writer.Close(ctx)`** — `main.go:287` passes `shutdownCtx`; each batcher's `close()` takes the ctx; the final flush's `attempt` runs under `min(writeTimeout, ctx deadline)` and the retry loop **never sleeps past the deadline**.
2. **On deadline overrun: remaining rows are counted via the existing `countDrops` path under a new stated drop-reason constant** (name at breakdown — the D5 posture extends to shutdown: loud log + per-workspace counts, never silent loss).
3. **Chart: `terminationGracePeriodSeconds` set explicitly to 30s** with the 10s app deadline inside it (margin covers receiver drain + admin shutdown, `main.go:284-293`'s ordering unchanged).
4. **Compose: ingest gains `stop_grace_period: 30s`** — Docker's 10s default SIGKILL would land inside the flush window; the sdk-samples' `stop_grace_period` precedent (`docker-compose.yml:202`) already establishes the pattern.
5. Evidence: a shutdown-under-load leg showing a clean flush inside deadline and a deadline-overrun leg showing the counted drop — red-then-green on the ctx threading.

### D264 (packet 15) — The out-loud no's: all four CONFIRMED

- **(a)** The two idea-doc items stay OUT of M4 — their own text agrees. **Decision moment confirmed: M7 planning (MCP scoping), per the idea doc's own placement**; the user may pull it to a dedicated earlier milestone-planning round — that pull is a user act, pre-registered here so it is never a drift.
- **(b)** Non-OTLP receiver families beyond Vercel+CloudWatch (GCP Pub/Sub, Event Hub, Heroku/Fly/Railway drains, syslog, Loki/Elastic compat) stay OUT — idea-doc backlog.
- **(c)** Dashboards persistence stays M5 — the workspace-store magnet is reaffirmed at this gate as at every gate since S1; S4 touching every deploy artifact changes nothing.
- **(d)** **D180's gate does not fire**: D252's sweep deletes telemetry rows past retention and creates no workspace-deletion surface. The gate stays registered, untouched.

---

### User round — advisor recommendations (USER-OWNED; not decided here)

| item | recommendation | ground |
|---|---|---|
| **U10** provider | **ratify your own lean — apply for GCP credits now (U16), decide on the landed amount: ≥$25k → GCP, else Railway-for-everything.** Note the D251(d) consequence plainly: Railway keeps PRD line 28's letter for all four pieces; Vercel-for-web is sanctioned under D251(d) but records a user-owned PRD deviation for the cloud web tier, and the mode-stamp must bind on the Vercel build | the ingest public HTTPS endpoint (`ingest.<domain>`) is the piece the connectors actually wait on — every option provides it; the decision can therefore follow the credits without delaying anything in S4 |
| **U11** domain | **buy it now, during S4.1** | cheapest, longest-shadow item; S5 cannot be sequenced without it and D101's rule keeps it out of copy until owned — buying early costs nothing and unblocks S5 planning the day S4 ends |
| **U12** monitor | **create the account before S4.4 breakdown if convenient, no later than S5 kickoff** | D256 builds the page monitor-agnostic, but a named monitor at S4.4 breakdown lets the panel slot be shaped against a known integration instead of a guess |
| **U13** design partners | **start recruiting NOW, in parallel with all of S4** | the longest lead time in M4; the S5 exit ("first 5 activated") is the one clause no sprint can compress |
| **U14** Polar production | **start organization verification now** | account-side lead time; the S5-GATE checklist (D173.5/D177/D200) consumes it |
| **U15** email | **launch without email, stated in the docs; decide a provider at S5 only if a concrete need lands** | invites are copyable links (U4); better-auth keeps verification additive (D95(c)); a provider bought for no consumer is speculative |
| **U16** GCP application | **submit now** | application-only cost; feeds U10 |
| *(new)* S4.3 scope | **keep the D258 `ai@7` sprint** — striking it is yours (D31-class SDK scope call) | the launch quickstart facing the current `ai` major; pre-registered by D101 as a launch-audience question |
| *(new)* `pitchdeck-assets/`, waitlist entries | **move `pitchdeck-assets/` out of the repo before the clean-checkout exit; export the collected waitlist entries before D257 removes the block** | both are your content; S4.1's hygiene pass and S4.4's waitlist removal touch their surroundings |

---

### Verdict and gates

**APPROVED FOR TASK BREAKDOWN** once D250–D264 are applied to §3/§4/§7 — final IDs **S4.1 → S4.2 → S4.3 → S4.4 → S5, sequential**.

- **S4.1 and S4.2 breakdown may begin immediately** — no user item changes their content (D251(d) explicitly de-couples S4.1 from U10).
- **S4.3 is cleared** — subject only to the user's D31-class strike option; if struck, the honest-absence fence (D259's shape) moves whole into S4.4 and S4.4 renumbers to S4.3.
- **S4.4 is cleared for breakdown; its dispatch is sequential-last** (docs written against final truth).
- **S5 remains structurally unplannable until U10 + U11 — unchanged standing posture.** When dispatched it is a **deploy sprint and returns to the advisor for a deploy kickoff round** (pipeline/secrets/rollout per the deploy-kickoff format). **The Polar sandbox→production promotion is a permanent critical item (D173.5).**

**Gate registrations.** **M4-GATE discharge path:** D105 (S4.2, both-directions proof), D101 receivers (S4.2 build / S5 activate, cards flip only at S5), D214 endpoint surface (S4.1 chart ingress + endpoint configurability / S5 reachability). **New:** `images` and `lint` are K3 forever-names; both trigger policies confirm on first real-runner numbers returning to the advisor (D137 shape). **S5-GATE inventory as §3 states it, plus:** the D262 dual-build topology (live app host / mock marketing host) is an S5 deliverable; `BLOB_READ_WRITE_TOKEN` removed from the inventory; U12 wiring. **M5-planning packet inherits:** D153, streaming instrumentation + JS logging bridge (D259). **M7-planning inherits:** the idea-doc decision moment (D264a). **Standing unchanged:** D178, G1, environment-ordering (`down -v`), D137/D41 watches, D207 per D261's consumption rule.

**Critical items returning to the advisor at breakdown/merge time:**

1. **S4.1** — the Dockerfile + standalone design with vendored-doc citations; the mode-stamp mechanism + red-then-green refusal proof; the compose secret posture (no-default line verbatim); the StatefulSet+PVC migration plan and the values surface against the D253 floor; `Writer.Close(ctx)` implementation + both grace numbers; the `ingest-endpoint.ts` configurability design (it feeds quickstart, connect flows, and the drive — D215's one-definition rule must survive); `images`/`lint` first real-runner numbers.
2. **S4.2** — the sweep design with the **measured** ClickHouse delete-semantics results attached; the both-directions retention proof; disclaimer removal in the same change; the two receiver routes + the measured Vercel/CloudWatch payload schemas with fixture provenance; the forwarder zip + local-invoke harness; the D218 window schema.
3. **S4.3** — the D78 additivity verdict on the `ai@7` path and the Responses API (**escalates before any non-additive change**); the D103(a) triage outcome; the D178 re-measure if any dep bumps.
4. **S4.4** — the complete landing-fence enumeration (S1 lesson 2); the docs-corpus honesty sweep + quickstart byte-check rerun; the `mock/docs.ts` deletion sweep; changelog-pipeline D246-sweep continuity; the `/status` replacement with the Loopwork deletion confirmed.
5. **S5** — the full S5-GATE block; **production promotion always returns to the advisor.** The M4 milestone exit-evidence bundle is the advisor's to sign, as every bundle has been.

## Run log (this plan)

- 2026-08-23 — **S4/M4 phase plan written at sprint altitude.** Split options A/B/C written with run-goals, exit criteria, fences and demoable increments; PM recommends C (three sequential dev sprints, then S5). Carry-forward ledger: 22 rows from the sprint bundles (the milestone bundle's narrower summary deliberately not used as the source). Decision packet: 15 items, 5 blocking (split; web image + build-mode seam; TTL mechanism; chart surface depth; docs architecture). User round: U10–U16, none blocking S4, U10/U11 blocking S5. Coverage F1–F17 with 1 gap (the undefined public demo) + 2 naming acts. No task breakdown — returns to the advisor first.
- 2026-08-23 — **Advisor ruled on the S4 packet: D250–D264 recorded in §9** (evidence verdict: "the plan's evidence is sound"; four imprecisions corrected, none void-making — notably the `batcher.go` bound is ~181.5s uncoordinated, not unbounded, and the Scale 90-day breach is conditional on a Scale catalog row landing). Split = **Option C ratified and EXTENDED to four sequential dev sprints S4.1–S4.4** (the `ai@7` obligation becomes its own sprint S4.3, before the content sprint so docs are written once against final SDK truth). Web image = standalone, root-context Dockerfile, **single-mode artifact with a boot-time mode-stamp refusal** (one mechanism discharges L6/D157 and S1 T12; Next specifics read from vendored docs at breakdown, never memory); web joins compose default profile with `BETTER_AUTH_SECRET` required-no-default. Retention = **hybrid: outer table TTL to 90d + a fixed-cadence retention sweep in ingest** reading `plans.retention_days` (per-row stamped TTL refused on D13 grounds; delete semantics measured at S4.2 breakdown; D105 disclaimer removal same change, both-directions proof). Chart floor = StatefulSets+PVCs IN, chart-owned Secrets with `existingSecret`, optional Ingress for web AND ingest (ingest ingress IS the D214 surface), managed-Postgres values, documented D123 rotation; external-secrets refused. Receivers = routes on the existing ingest HTTP mux behind the D98 bearer path; CloudWatch forwarder = dependency-free single-file Lambda relay, no SAM/Terraform; payload schemas measured; SOON cards flip only at S5. Docs = **in-repo MDX route group in `apps/web`** — one renderer IS the one content source; `mock/docs.ts` DELETED; `/changelog` joins the pipeline with the four true entries migrating verbatim; the Loopwork `/status` fiction DELETED, real page ships monitor-agnostic until S5. Landing: prototype footer removed, nav gains Docs+Status, pricing copy gains a mirror test, **waitlist REMOVED** (`BLOB_READ_WRITE_TOKEN` exits the env inventory). `ai@7` + Responses API = S4.3, additive-or-escalate under D78; streaming + JS logging bridge OUT with honest absence in docs and an M5-planning owner; D218 windowed rate IN at S4.2; new K3 forever-jobs **`images`** and **`lint`** (the 6 eslint errors fixed at birth); D132→S4.1, D153→M5-planning deferral, hygiene strays→S4.1. Public demo = **the mock-stamped image variant served as the marketing host** (live seeded-workspace demo refused); D262 names the S5 dual-build topology. `Writer.Close(ctx)` threads the shutdown deadline with counted overrun drops; grace periods explicit in chart and compose. **Verdict: APPROVED FOR TASK BREAKDOWN — S4.1/S4.2 cleared immediately; S4.3 cleared subject to the user's D31-class strike option; S4.4 sequential-last; S5 unplannable until U10+U11.** User round U10–U16 + two new items presented to the user with advisor recommendations.
- 2026-08-23 — **User round, first two answers: S4.3 is KEPT** (the D31-class strike option is declined — the D258/D259 scope stands: `ai@7` + Responses API ship in obstack-js before the docs sprint, additive-or-escalate under D78), and **S4.1 is DISPATCHED to dev-team** on the §3 run-goal line, verbatim, under the D250–D264 rulings. Standing model roles apply (Opus 5 executors and reviewers). Remaining user items (U10–U16, `pitchdeck-assets/` move, waitlist export) stay open — none block S4.1–S4.4; U10/U11 block S5. Sprint statuses now: **S4.1 dispatched · S4.2 cleared · S4.3 cleared (kept) · S4.4 cleared, sequential-last · S5 blocked on U10/U11.**
- 2026-08-30 — **User-captured idea registered for the M5-planning packet:** agent evaluation (final-output + tool-call scoring, evaluation pipeline, evals dashboard/alerts). Surveyed and written up at `.planning/2026-08-30-idea-agent-evaluation.md`: the performance branch already exists; tool arguments/agent outputs are frozen out by D78's "no input/output capture" line (escalation, not extension); scoring and the pipeline are M7/M6 per the PRD's own phases. PM lean: decide the opt-in capture escalation at M5 planning (vehicle B), scoring stays M6/M7 unless the user re-sequences (D31-class). Nothing enters S4.3/S4.4/S5.
