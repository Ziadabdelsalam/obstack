# S7 — M6 Ops Suite — Phase Plan (sprint altitude)

meta:
- date: 2026-09-01
- repo/branch: `master` @ `f14efc7` (clean tree; = M5 bundle commit; production = `1c957ef`)
- trigger: M5 CLOSED (`.planning/2026-09-01-m5-milestone-bundle.md`) — S7 planning is the pre-registered next step (M5 phase plan §6, D20 per-phase planning).
- source of truth: `.planning/2026-08-15-obstack-backend-build-vision.md` (S7 bucket lines 80–86, coverage amendment 1) + M5 phase plan §3 sizing rows + §6/§8 M6 frame + a fresh five-surface + machinery inventory (2026-09-01, this session; findings inlined in §2/§3).
- process: Fable-direct planning (S6.4 T7 precedent, user-directed minimal-model approach). Sprint IDs provisional until the §8 rulings close.
- predecessor: M5 CLOSED clause-by-clause at `1c957ef`; issues already live (D361 pull-forward, S6.2) — it does NOT reappear below.

---

## 1. GOAL — what M6 adds

obstack acts on what it observes. The milestone's one net-new subsystem is the **eval + notify layer**: scheduled evaluation of rules against the real stores (ClickHouse spans/summaries/metrics), producing events that a **notifier** delivers to channels. On top of it, five surfaces leave mock: **alerts**, **slos**, **incidents**, **oncall**, **changes**.

**Common exit (M6, proposed):** alerts, slos, incidents, oncall and changes render the signed-in workspace's real data in live mode (each flipped in `live-routes.ts`), an alert rule evaluated on schedule against real data produces a real event delivered to a real channel, and the public demo is byte-unchanged in mock mode (D114/D21). The fence release owed from M5 ships with the changes feed: services' deploys panel drops its `SampleMark` (D362).

---

## 2. Foundation facts — what exists today (inventoried 2026-09-01)

- **All five routes are pure mock renders** (client components importing fixtures): `alerts/page.tsx` (124 ln, `mock/intelligence.ts` — `AlertRule`×8, `AlertEvent`×4), `slos/page.tsx` (107 ln, `mock/slos.ts` — `Slo`×4 with window/target/burn), `incidents/page.tsx` (110 ln, `mock/incident.ts` — ONE incident, detail view only, **no list route exists**), `oncall/page.tsx` (133 ln, `mock/oncall.ts` — rotations/policies/channels/routing cross-referenced by name/id), `changes/page.tsx` (84 ln, `mock/changes.ts` — flat timeline, 6 kinds, `incident?` flag).
- **No eval/notify machinery anywhere**: no scheduler beyond purpose-built tickers (`retention.go`, `metering.go`, `batcher.go` — the house pattern for background loops, none reusable as-is), no notifier/webhook/Slack/email/pager client code, no alert/slo/incident/oncall/changes backend module or API route. **M6 is a from-scratch build of the eval/notify layer**, then wire-ups.
- **Storage**: M6 state is Postgres-track (`pgmigrations/`, next = `0010`); evaluation READS are ClickHouse through the existing `forWorkspace` scoping. The two migration tracks stay distinct.
- **e2e drive**: zero coverage of the five routes today — every sprint below grows the drive in place (D107 pattern), RED-first per S6.3 condition 7.
- **Mock cross-references are the implied contract**: `alertRouting` joins rule-name → escalation policy → channels; `Change.incident` flags entries inside an incident window; the incident timeline is documented as reconstructed from alerts/changes/traces/metrics sharing the window. The real schema keeps these as FK relations / window joins, not strings.

---

## 3. Per-surface sizing (updated from the M5 table with the inventory)

| Surface | Real source | Size | Note |
|---|---|---|---|
| alerts | NEW eval engine + notifier + Postgres rules/events | **XL** | THE M6 foundation; everything else rides it |
| changes | webhook-fed event store (deploy/flag/config events) | **L, fenced** (XL as mocked) | v1 fence: one generic ingest endpoint + GitHub Actions shape — not a connector catalog (§5) |
| slos | defs store + scheduled burn queries over summaries/metrics | L | rides S7.1's scheduler; pure read + threshold events |
| incidents | Postgres objects + cross-surface window timeline + RCA via Explain | L | blocked on alerts + changes being real; needs the net-new LIST route |
| oncall | rotations/escalations riding the notifier — OR pager integration | **XL if built / M if fenced** | §8 ruling R1 |
| security | (M7's) | — | §8 ruling R2: pull forward or not |

---

## 4. Calibration — unchanged

Eighteen closed runs now say one coherent area per run (M5 added four more, zero fix waves). The largest sprint below (S7.1) is one subsystem + one surface = S6.1's exact class, the known ceiling. Sequential-only stands (D364's grounds unchanged: shared `live-routes.ts`, one drive, single-threaded review).

---

## 5. Sprint split — proposal (sequential; IDs provisional until §8)

#### S7.1 — the eval + notify foundation + alerts
- **run-goal:** M6 sprint 1 — alerts for real (exit: alert rules CRUD persists per-workspace in Postgres (`0010`), a scheduler evaluates enabled rules on cadence against ClickHouse through the frozen query contracts, rule state transitions (ok→firing→resolved) produce events persisted and delivered by a notifier to at least one real channel kind, `/app/alerts` renders the workspace's real rules + events and is flipped in `live-routes.ts`; mock byte-identical).
- **scope fence:** channel kinds v1 = **webhook + Slack-webhook only** (both are one HTTP POST; email needs a sender we've never built — U4 precedent — and pager kinds are R1's); condition language v1 = threshold over a named metric/aggregate from the EXISTING query contracts (no free-form query language); evaluation cadence fixed per plan tier, not per rule; no anomaly detection (vision Phase-2 wording stays post-M6).
- **pre-breakdown packet (D363 precedent, REQUIRED):** eval-engine design — where the scheduler lives (the ingest binary's ticker pattern vs a new subcommand), rule-condition representation, firing-state machine + dedup/re-notify policy, event retention, `0010` DDL, notifier delivery semantics (at-least-once? retry?), fail-open posture when ClickHouse is slow. The packet freezes the alerts query/mutation contract from `mock/intelligence.ts` before DDL.
- **demoable as:** "your rule, your data, your Slack ping."

#### S7.2 — changes (the deploys feed)
- **run-goal:** M6 sprint 2 — change tracking for real (exit: a workspace-keyed change-event ingest endpoint accepts deploy/config/flag/scale/secret/infra events (the six mocked kinds), events persist in Postgres, `/app/changes` renders the workspace's real timeline flipped in `live-routes.ts`, a documented GitHub Actions step posts a real deploy event end-to-end, and services' deploys panel drops its `SampleMark` (D362 fence release)).
- **scope fence:** ONE generic authenticated endpoint (existing api_keys auth) + the GHA recipe — no per-provider connector catalog, no polling, no flag-provider SDKs; that fan-in is catalog-gated later work. Pulled to second per the pre-registered M5 flag: zero alert-engine dependency, three consumers unblock (services' panel now, incidents' timeline in S7.4, evals in M7).
- **demoable as:** "your deploys annotate your telemetry."

#### S7.3 — slos
- **run-goal:** M6 sprint 3 — SLOs for real (exit: SLO definitions CRUD per-workspace, burn computed by S7.1's scheduler over summaries/metrics, breach/at-risk raises events through the S7.1 pipeline, `/app/slos` flipped; mock byte-identical).
- **scope fence:** objectives v1 = the mocked shapes only (availability + latency-quantile over existing aggregates); no custom SLI query builder.
- **demoable as:** "error budget, computed, honest."

#### S7.4 — incidents
- **run-goal:** M6 sprint 4 — incidents for real (exit: incident objects CRUD in Postgres, the timeline stitched by window-join over the workspace's real alerts + changes + traces/metrics, RCA reuses the Explain rail (existing quota/facade), the net-new list route + the detail view flipped; mock byte-identical).
- **scope fence:** creation v1 = manual + from-alert promotion; no auto-incident heuristics; RCA rides Explain's existing per-plan limits unchanged.
- **demoable as:** "the incident tells its own story."

#### S7.5 — oncall (shape set by R1)
- **run-goal (if R1 = fenced build):** M6 sprint 5 — oncall for real (exit: rotations + escalation policies + channel routing CRUD per-workspace, the S7.1 notifier consults routing/rotation to pick delivery targets, escalation steps walk on unacknowledged critical events, `/app/oncall` flipped; mock byte-identical).
- **scope fence (fenced build):** no calendar sync, no mobile push, no ack-via-channel round-trip (ack is in-product), schedules v1 = the mocked weekly-rotation shape only. This is the M-sized reading; the XL reading (full scheduler subsystem) is explicitly NOT proposed.
- **demoable as:** "the right person gets the page."

| dimension | one-run | 3 sprints (batch small ones) | 5 sprints (rec) |
|---|---|---|---|
| largest vs calibration | >> S1 | slos+incidents+oncall batches 3 areas | ≈ S6.1 class max (S7.1) |
| overrun blast radius | everything | a third of the milestone | one sprint |
| fence-release latency (D362) | end | mid | S7.2 — early |

---

## 6. M7 — frame only (unchanged from M5 phase plan §6)

pipelines → security (if not pulled forward, R2) → mcp → evals → ask (capstone, last). Own phase plan when M6 closes.

---

## 7. Standing constraints binding every sprint above

- D21/D114 byte-identity + the `live-routes.ts` flip as each surface's exit; D13 honesty (fenced-out data absent, not invented); D7/D11 tenancy on every new object, proven red.
- The drive grows in place, RED-first (S6.3 condition 7); metric/name literals single-sourced (S6.4 condition 13 pattern).
- New background loops follow the house ticker pattern and live in the ingest binary unless the S7.1 packet rules otherwise; deploy-shaped work goes to deploy touchpoints, not dev sprints; every sprint closes with the K0 staging gate + production promotion in its ship log (S6.x pattern).
- Notifier egress is a NEW capability class (the product initiating outbound HTTP to user-supplied URLs): SSRF posture (deny link-local/metadata ranges), per-workspace rate limits, and secrets-in-config handling are in-scope for the S7.1 packet, not afterthoughts.

## 8. Rulings — CLOSED (user-signed 2026-09-01; plan APPROVED for S7.1 pre-breakdown packet)

- **R1 — oncall = FENCED IN-HOUSE BUILD.** The M5 presumption ("integrate a pager provider") is beaten by the fenced reading: the S7.5 scope fence (no calendar sync, no mobile push, in-product ack only, weekly-rotation shape only) prices the build at M, keeps self-hosted parity, and adds no vendor credential surface. The XL full-scheduler reading stays off the table; if breakdown re-prices the fenced build above M, escalate — do not silently widen.
- **R2 — security STAYS M7.** No enterprise-demand signal on record; the vision's reservation is discharged for this planning moment. Re-openable only by a real demand signal, at M7 planning or earlier by user directive.
- **R3 — changes-to-second CONFIRMED.** S7.2 as ordered; the D362 fence release ships mid-milestone, not at the end.
- **R4 — split + fences APPROVED as proposed.** Five sequential sprints S7.1 → S7.5; webhook + Slack-webhook channels only in v1; changes v1 = one generic endpoint + the GHA recipe; no anomaly detection. IDs final.

**Next gate:** the S7.1 pre-breakdown packet (§5, D363 precedent) — no DDL or engine task dispatches before the packet is ruled.
