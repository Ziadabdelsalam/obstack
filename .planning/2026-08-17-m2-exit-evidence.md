# M2 exit evidence — Correlation Complete

- date: 2026-08-17
- milestone: **M2 — Correlation Complete** (vision doc `.planning/2026-08-15-obstack-backend-build-vision.md` §S2; phase plan `.planning/2026-08-16-s2-m2-phase-plan.md`)
- sprints: S2.0 (CI) → S2.1 (restructure) → S2.2 (collector + nearby joins on kind) → S2.3 (search + LogsExplorer + saved views) → S2.4 (SDKs, exit-blocking per D34)
- assembled by: S2.4 T5 (the phase plan's pre-registered critical item, §8)
- status: **for advisor signature.** The merge call is the user's.

This document does one thing: it takes the amended M2 exit line apart clause by
clause and points each clause at dated, re-runnable, already-signed evidence. It
introduces no new claim. Where a clause was amended, the amendment and its
signature are named beside it.

## The exit line, verbatim

> **Exit (amended per D30/D34, user-signed 2026-08-16):** the demo app running
> on K8s (kind cluster in CI) shows API→agent→LLM spans with correlated pod logs
> — solid and nearby — in one view, **the LogsExplorer surface searches real
> logs with saved views that persist per browser (localStorage) and survive a
> reload** — workspace-scoped saved views land with Postgres in M3 (PRD §6),
> pre-registered as an M3-gate item — **and a sample app instrumented only with
> the obstack SDK (install + the documented two-line setup) produces the same
> four-layer trace.**

Two amendments are inside that sentence and both are user-signed on 2026-08-16:
**D30** reworded the saved-views clause from "persisted per workspace" to
"persist per browser (localStorage)", because the store PRD §6 names (Postgres)
is an M3 deliverable and building a throwaway one in M2 would have been a
stopgap; **D34** added the SDK clause, which made S2.4 exit-blocking. Neither
amendment reduced what M2 must prove — D34 enlarged it.

## Clause 1 — "the demo app running on K8s (kind cluster in CI) shows API→agent→LLM spans with correlated pod logs — solid and nearby — in one view"

**Owner: S2.2.** Signed at **`02bd695`** (`s2.2-collector-correlation`, PR #11, merged).

| sub-clause | evidence | form |
|---|---|---|
| running on K8s, kind cluster in CI | the `stack` CI job (`.github/workflows/stack.yml`) stands the whole stack up on kind through the real Helm chart — D35: Helm is the only kind path | every-PR CI job, 4m17s at the signed tip `02bd695` (the S2.2 plan's closing record; 4m11s at this sprint's tip `dc4163e`, run [32043633406](https://github.com/Ziadabdelsalam/obstack/actions/runs/32043633406)) |
| API→agent→LLM spans in one view | `deploy/helm/obstack/acceptance.sh` drives one `POST /chat` at the in-cluster demo app and asserts the four-layer waterfall through the D17 tsx facade harness against the cluster's ClickHouse | one command, re-runnable |
| **solid** pod logs (D37.1) | ≥1 log row carrying the trace's `trace_id` **and** populated pod metadata, asserted by the same script | assertion |
| **nearby** pod logs (D37.2) | ≥1 row from a second, deliberately *uninstrumented* sidecar container, joined on (workspace, namespace, pod) + the shared window constant — container is display data, never a join key (D37) | assertion |
| the two are visually distinct, and nothing is double-counted (D37.3) | zero duplicated bodies across the OTLP and filelog paths | assertion |
| `obstack-collector` ships as config-only OTel Collector, container **and** DaemonSet | `deploy/collector/` (pinned upstream image, D14) + the chart's DaemonSet, both exercised by the same run | artifact + assertion |

Reproduce: `kind create cluster --name obstack-stack && bash
deploy/helm/obstack/acceptance.sh` — the exact script the chart README gives a
human, and the exact line the `stack` job runs (S2.1 L3). The acceptance
criteria D37.1–D37.3 are stated in `deploy/helm/obstack/README.md`.

## Clause 2 — "the LogsExplorer surface searches real logs with saved views that persist per browser (localStorage) and survive a reload"

**Owner: S2.3.** Signed at **`4bfc877`** (`s2.3-search-saved-views`, PR #12
merged at `9fabcde`). Bundle: **`.planning/2026-08-17-s2.3-exit-evidence.md`** —
25 claims asserted, 25 passed, 62s, from destroyed volumes.

| sub-clause | evidence in that bundle |
|---|---|
| `/app/logs` runs on the real `logs` table | §2, against a seeded workspace of 245 log rows counted independently in SQL |
| real trace search: filters, free text, honest totals, pagination | §1 — 220 traces over a 200-row page, `200 of 220`, page 2 deep-linked and disjoint, free text finding tokens that exist *only* in a span prompt, *only* in a log body, and *only* on a D42 carrier row |
| saved views persist per browser and survive a reload | §3–§4, driven through a real headless Chrome over CDP against `localStorage`, asserted after an actual reload |
| no SAMPLE badge on a wired surface; empty states are real (D13/D21) | §1's last two rows — a term matching nothing renders the empty state and `0 of 0`, never a mock fallback |
| the denominator is trustworthy | §"The dataset" — 0 phantom `trace_id=''` rows, so the totals claim is about the data and not about an artefact |

Reproduce: `bash deploy/compose/exit-evidence.sh`.

The clause's own escape hatch is honoured rather than glossed: workspace-scoped
saved views are **not** claimed here. They land with Postgres in M3 (PRD §6) and
are carried below.

## Clause 3 — "and a sample app instrumented only with the obstack SDK (install + the documented two-line setup) produces the same four-layer trace"

**Owner: S2.4** (this sprint; exit-blocking per D34). Bundle:
**`.planning/2026-08-17-s2.4-exit-evidence.md`** — 28 claims asserted, 28
passed, 69s, from destroyed volumes, at tip `dc4163e` on `s2.4-sdks` (PR #13).

| sub-clause | evidence |
|---|---|
| "instrumented **only** with the obstack SDK" | neither sample imports OpenTelemetry: `grep -rn opentelemetry demo/sdk-sample-py --include='*.py'` → 0; the one `@opentelemetry` string in `demo/sdk-sample-ts/src` is a comment |
| "install" | Python: a real PEP 517 wheel from `pip install './packages/obstack-py[fastapi]'`. TypeScript: the `npm pack` tarball a customer would get, installed from the file — which is what proves the package's `files`/`exports`/types rather than reaching around them |
| "the documented two-line setup" | `import obstack; obstack.init()` / `import { init } from "obstack-js"; init();` plus the `traceAgent`/`traceTool` pair. Nothing else is telemetry code |
| "produces the same four-layer trace" | `sdk-sample-py` 7 spans and `sdk-sample-ts` 6 spans, each one trace, each with `api`/`agent`/`tool`/`llm` and the full D8 GenAI set, asserted in SQL and then re-asserted through the shipped D17 facade |
| the same shape the demo app produces | `demo/agent-app/` is untouched (D15, asserted by the evidence script) and remains the bring-your-own-OTel proof; "validates against the demo app" is a claim about trace **shape**, never conversion |

Two clauses of S2.4's own exit criterion go beyond the M2 sentence and are
proven in the same run: the SDKs are thin over standard OTel (each sample once
against a stock upstream collector, its output asserted to carry the span names
and `gen_ai.*` attributes) and they fail open (each sample answers 200 with its
endpoint on a dead port, with nothing of that run reaching ClickHouse).

Reproduce: `bash deploy/compose/sdk-evidence.sh`.

## The coverage table, closed out

Phase plan §6 decomposed the exit line into E1–E15. Status at this document's
date:

| # | condition | owner | status |
|---|---|---|---|
| E1 | CI exists and guards PRs with the M1 suites | S2.0 | met — `web`, `go` on every PR |
| E2 | CI can create a kind cluster and run a locally built image | S2.0 | met — `kind` |
| E3 | the stack runs on that kind cluster | S2.2 | met — `stack` via the Helm chart (D35) |
| E4 | `obstack-collector` config-only: container **and** DaemonSet | S2.2 | met |
| E5 | API→agent→LLM spans render as one trace from the cluster run | S2.2 | met |
| E6 | solid (`trace_id`) pod logs render | S2.2 | met (D37.1) |
| E7 | nearby (namespace/pod/container + window) logs render, distinct | S2.2 | met (D37.2/D37.3) |
| E8 | GenAI log-event prompt/completion extraction into the D7 columns | S2.2 | met (D38(e) fixture through the collector) |
| E9 | collector-originated spans populate the `infra` layer | — | **struck, not missed.** D32 ruled it unimplementable: a config-only collector originates logs, not spans. `infra` stays a reserved Enum8 value; its producer rule is defined at M5 planning |
| E10 | real trace search: filters + free text + honest totals + pagination | S2.3 | met |
| E11 | LogsExplorer runs on real `logs`-table search | S2.3 | met |
| E12 | saved views persisted per workspace | S2.3 | met **as amended** — D30 (user-signed) rewrote this to per-browser `localStorage`; workspace scope is an M3 gate |
| E13 | `obstack-py`: OpenAI/Anthropic auto-instrumentation + `@trace_agent` | S2.4 | met — OpenAI e2e, Anthropic unit-level (D77(e)) |
| E14 | `obstack-js`: Vercel-AI/OpenAI/Anthropic + `traceAgent` | S2.4 | met — Vercel-AI and OpenAI e2e, Anthropic unit-level (D77(e)) |
| E15 | live-wired surfaces carry no SAMPLE badge, real empty states | S2.3 | met |

Both gaps §6 recorded are resolved rather than carried: E9 by a ruling that
removed it from the exit, E12 by a user-signed amendment to the exit's wording.

## Carried to M3, pre-registered (nothing here is a surprise later)

| item | source | what M3 must do |
|---|---|---|
| workspace-scoped saved views | D30, inside the exit line itself | move saved views to Postgres per PRD §6 |
| SDK registry names | D79, **USER-VISIBLE** | PyPI `obstack` is squatted by an unrelated package; `obstack-py`/`obstack-js` were free on 2026-08-17. **Publish or re-verify both names at M3 planning, before the onboarding quickstart renders them** — an unpublished free name can be taken |
| `ai@7` telemetry path | D88 | `ai` 7 emits no OTel span (it moved to a `node:diagnostics_channel` integration registry). The quickstart will meet `ai@7` users; a named owner is assigned at M3 planning |
| shell/marketing fiction in live mode | D60 as widened by D63 | the CommandPalette's four mock trace links 404 honestly in live mode; the clean fix needs a client-side mode signal the shell deliberately lacks |
| build env is part of the artifact | S2.3 L6, **M4-GATE** | no mock-built web artifact may be served as live evidence |

## What M2 does not claim

Stated so the milestone closes on what was measured (D13/D21):

- **No hosted deployment.** Every cluster in this bundle is a CI kind cluster.
  The provider decision is still the user's (M4/S5).
- **No registry publication.** Neither SDK is on PyPI or npm; both install from
  source, and every README says so.
- **No streaming LLM instrumentation, no Responses API** in either SDK — absence
  rather than a zero-token span that would price to $0.
- **No logging-framework bridge in `obstack-js`** (D84). Correlated logs are
  claimed for `obstack-py`, where they exist, and nowhere else.
- **`sdk-e2e` has not yet run on GitHub.** Its trigger policy is set from a
  local measurement with stated conditions; the first CI run replaces the
  number.

## Signature block

| | |
|---|---|
| S2.2 evidence signed at | `02bd695` |
| S2.3 evidence signed at | `4bfc877` (bundle `.planning/2026-08-17-s2.3-exit-evidence.md`) |
| S2.4 evidence at | `dc4163e` + this sprint's T5 commit (bundle `.planning/2026-08-17-s2.4-exit-evidence.md`) |
| M2 exit amendments | D30, D34 — both user-signed 2026-08-16 |
| advisor signature | *pending* |
| merge call | the user's |
