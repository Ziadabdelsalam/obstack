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

To persist those instead of exporting them every time, put them in `apps/web/.env.local`, not a root `.env.local` — Next reads env from the app directory it runs in, and since the monorepo move that's `apps/web`. A stale root `.env.local` is silently ignored, so live mode fails D13's fast check on a missing `CLICKHOUSE_URL` and looks like a broken restructure rather than a misplaced file.

`OBSTACK_DATA_MODE` is a BUILD-time input; serve an artifact only in the mode it was built — a mock-built artifact prerenders the no-form auth pages and cannot sign anyone up.

Point your own service at `http://localhost:4318` (OTLP/HTTP) or `:4317` (gRPC) with `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local` and its traces show up the same way. `ok_dev_local` is the local dev key: API keys are rows in Postgres, and the ingest migrations seed this one, so it works on a clean stack with nothing to configure. Details, keys, users, schema and the manual verification checklist: `deploy/compose/README.md`.

## The SDKs

There are two ways to send obstack a four-layer trace. Wiring the standard
OpenTelemetry SDK yourself is one, and `demo/agent-app/` is the running proof of
it. The other is an obstack SDK: an install and two lines.

```python
import obstack; obstack.init()          # obstack-py, before the imports it instruments
```

```ts
import { init } from "obstack-js"; init();   // first module executed
```

`init()` sets up the stock OTel providers and OTLP exporters from the standard
`OTEL_*` environment (no obstack-specific variable exists), turns on HTTP/
framework instrumentation so the `api` layer appears, and patches the LLM
clients your app already has. `@obstack.trace_agent` / `traceAgent` and
`@obstack.trace_tool` / `traceTool` name the two things no library can infer.
Cost is not computed here — the SDKs carry no pricing logic at all; ingest
prices from the tokens and model they report.

**Pre-release: the registries hold the names, not the packages.**
`obstack-py 0.0.1` (PyPI) and `obstack-js 0.0.1` (npm) are name-hold
placeholders marked do-not-use — installing either gets you none of this code.
The real releases publish at launch; today both install from source, which is
what the sample apps and the in-product quickstart do:

```bash
pip install './packages/obstack-py[fastapi]'                       # Python
npm pack ./packages/obstack-js && npm install ./obstack-js-0.1.0.tgz  # TypeScript
```

### What is actually instrumented

Everything in this table has a test or an evidence run behind it, and nothing
that is not in it is claimed. "e2e" means the call ran through the real client
library and the resulting span was read back out of ClickHouse.

| | `obstack-py` | `obstack-js` |
|---|---|---|
| OpenAI `chat.completions.create` | e2e (`demo/sdk-sample-py`), sync + async | e2e (`demo/sdk-sample-ts`), `openai >=4.85 <8` |
| Anthropic `messages.create` | unit-level: real client, local fake, in-memory exporter | unit-level, `@anthropic-ai/sdk >=0.50 <1` |
| Vercel AI SDK `generateText` | — | e2e, via `experimental_telemetry` + an `ai.*`→`gen_ai.*` span processor, `ai >=5 <7` |
| `api` layer | FastAPI, via the `obstack-py[fastapi]` extra | `@opentelemetry/instrumentation-http` (hard dependency) |
| correlated logs | yes — root-logger bridge installed by `init()` | no logging-framework bridge this release; the LoggerProvider is registered |

Bounds in that table are measurements, not guesses: below `openai` 4.85 the
module obstack-js patches does not exist and the same call produces no span at
all, and `ai` 7 emits no OpenTelemetry span (it moved to a
`node:diagnostics_channel` registry). The package READMEs give the numbers.

Common to both, and equally deliberate: **streaming calls pass through
uninstrumented** — a GenAI span with zero tokens would price to $0, and an
absent span is the honest form; only the chat-completions/messages APIs are
covered, not the Responses API; prompt and completion are read from the
dedicated ClickHouse columns, never from a span's attribute map; and a broken
endpoint never breaks the app (PRD §9) — the SDK logs a warning and the request
still answers.

The two sample apps are the proof, each instrumented with nothing but the two
lines: `demo/sdk-sample-py/` and `demo/sdk-sample-ts/`, both runnable standalone
against the compose stack. One command asserts the whole claim from destroyed
volumes:

```bash
bash deploy/compose/sdk-evidence.sh
```

That boots ClickHouse, ingest and both samples, sends each one request, and
asserts in SQL that both landed one ≥4-span trace with all four layers and the
full GenAI attribute set; that both render through the app's own query facade;
that a stock upstream OTel Collector — no obstack config anywhere — receives the
same trace over standard OTLP; and that each sample still answers `200` with its
endpoint pointed at a dead port.

## What's real vs. mock

Everything visual is real code (Next.js + Tailwind + Recharts). With `OBSTACK_DATA_MODE=live` the traces list, the trace view, the logs explorer (`/app/logs`) and the overview charts read ingested telemetry from ClickHouse; every surface not yet wired to the pipeline is marked with a `SAMPLE DATA` badge in the UI. The logs explorer searches a bounded, capped window of the `logs` table and refreshes when you ask it to — nothing on any surface tails or polls. In the default mock mode all data is fictional, generated deterministically in `apps/web/src/mock/` — including three scripted failure stories that demonstrate cross-layer correlation (pod OOM-kill → truncated completion → 502; tool-timeout retry chain; provider rate-limit cascade).

## CI

Eight checks run on every pull request against `master`: `web`, `go`, `kind`, `stack`, `e2e`, `sdk-py`, `sdk-js`, `sdk-e2e`. Workflow definitions live in `.github/workflows/{web,go,kind,stack,e2e,sdk-py,sdk-js,sdk-e2e}.yml`. Making any of them *blocking* is branch protection, which is not configured yet — see "Required checks" below.

- **`web`** (`.github/workflows/web.yml`) — Node 24, the active-LTS major meeting Next 16.3's documented floor (20.9.0+, per `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`). Brings up ClickHouse **and `ingest`** via the same compose services local dev uses (ingest owns the schema, so a bare ClickHouse has no `obstack` database for the ClickHouse-backed tests to read), then runs `npm ci` against the committed `package-lock.json`, `npm test` (the tsx `node:test` runner) and `npm run build`. Like `go`, it fails on any unexpected test skip — the `node:test` runner's own skipped-count must be present and must agree with the skip lines the trap can see, so a self-skipping integration test cannot read as coverage it doesn't have. `setup-node`'s `cache: 'npm'` caches npm's package download cache only, keyed on `package-lock.json`; no `.next` build output is cached, because a cache keyed on `package-lock.json` alone would risk reusing prerenders across `OBSTACK_DATA_MODE` changes (the M1 F6 finding). CI therefore always builds from a clean checkout.
- **`go`** (`.github/workflows/go.yml`) — Go 1.25.4 (pinned in `services/ingest/go.mod`), anchored on `services/ingest`. Brings up ClickHouse via the same compose service local dev uses and Postgres as a service container (it needs nothing but environment, where ClickHouse needs `deploy/compose`'s `users.d` — which a container starting before checkout cannot mount), then runs `gofmt -l`, `go vet ./...` and `go test -v -count=1 ./...` against both, carrying the two D11 ClickHouse users (`obstack_ingest` write, `obstack_web` readonly) and the Postgres DSN the migration set's integration tests need. `-count=1` is load-bearing — without it, Go can replay a cached package result from `GOCACHE` and report "PASS" without ever contacting ClickHouse. Any `--- SKIP` in the test output fails the job: a ClickHouse-dependent test that can't reach a server errors instead of silently skipping and reading as coverage it doesn't have.
- **`kind`** (`.github/workflows/kind.yml`) — builds the demo agent image (`demo/agent-app/Dockerfile`) tagged with the commit SHA, creates a kind cluster, loads that image in (`imagePullPolicy: Never` makes a registry fallback impossible), and applies the proof workload (`.github/ci/kind-proof-workload.yaml`). After the pod reports Ready, the job waits for it to emit real telemetry against a deliberately black-holed OTLP endpoint and confirms it stayed `Running`/`Ready` anyway — proving the OpenTelemetry SDK's fail-open property, not just that the container started. **Trigger policy**: runs on every PR, same as `web` and `go` — there is no label or manual trigger, so opening a PR or pushing to its branch is what fires it. Measured end-to-end wall-clock (job start to cluster teardown) is ~1m37s (run [31933353051](https://github.com/Ziadabdelsalam/obstack/actions/runs/31933353051)), well under the ~6-minute line the trigger policy is decided on — past that line the job would move to a `ci:kind` label + push-to-`master` + `workflow_dispatch` trigger and drop out of the required-checks set rather than leave a required check some PRs never fire.
- **`stack`** (`.github/workflows/stack.yml`) — stands the whole stack up on a kind cluster through the real Helm chart (`deploy/helm/obstack/`, the only kind path — D35) by running `deploy/helm/obstack/acceptance.sh`, the exact script the chart README tells a human to run. It drives one `POST /chat` at the demo app and asserts the sprint's correlation evidence through the tsx facade harness against the cluster's ClickHouse: the four-layer waterfall, ≥1 solid log row with pod metadata, ≥1 nearby row from the uninstrumented sidecar, and zero duplicated bodies. **Trigger policy**: every PR, same as `web`, `go` and `kind` — measured wall-clock is ~4m (e.g. run [31962751881](https://github.com/Ziadabdelsalam/obstack/actions/runs/31962751881)), under the same ~6-minute line; past it the job moves to a `ci:stack` label + push-to-`master` + `workflow_dispatch` and drops out of the required-checks set.
- **`e2e`** (`.github/workflows/e2e.yml`) — the tenancy exit assertion as a check (D107): it brings the compose stack up, runs `bash deploy/compose/smoke.sh` as the pipeline floor (D136 — that harness had no CI run of record before this), and then runs `deploy/compose/e2e-drive.mjs`, the promoted CDP drive, in the three lines `deploy/compose/README.md` tells a human to run. Two strangers sign up through the real form in two fresh throwaway Chrome profiles, each lands in the organization and workspace their own signup created, each gets telemetry seeded for exactly the workspace id the product rendered for them, and the drive then asserts strict disjointness plus the cross-tenant negative probe — one workspace asking for the other's trace id — through the product's own surfaces rather than a query written for the test. It refuses loudly rather than clean up after anything it did not start. **Trigger policy**: every PR **provisionally**, pending the advisor's ruling on the first real-runner numbers, which are the only ones a trigger policy is decided on (`sdk-e2e`'s local 6m01s versus its real 3m43s is the standing warning); the local composite is **84s** — 13s boot + 17s smoke + 54s drive, twice — and excludes what the runner pays most for (`npm ci`, the ingest image build), so it is a floor, not an estimate. Past the ~6-minute line the job moves to a `ci:e2e` label + push-to-`master` + `workflow_dispatch` and drops out of the required-checks set.

- **`sdk-py`** (`.github/workflows/sdk-py.yml`) — Python 3.14; runs `packages/obstack-py`'s "Development" block verbatim: a venv, one editable install with the `[fastapi]` extra plus the exactly-pinned `requirements-dev.txt`, then `pytest packages/obstack-py`. Split from `sdk-js` rather than combined so a red check names the language at fault. It does not build a wheel — `sdk-e2e` does, because the sample's image installs the package for real. **Trigger policy**: every PR; measured 18.0s with a warm pip cache and 34.8s with an empty one (Apple M4, 10 cores, Python 3.14.6), far under the ~6-minute line.
- **`sdk-js`** (`.github/workflows/sdk-js.yml`) — Node 24; `npm ci`, then `npm test --workspace packages/obstack-js` (the repo's `tsx --test` / `node:test` runner, 42 tests driving the real `openai`, `@anthropic-ai/sdk` and `ai` clients against local fakes) and `npm run build --workspace packages/obstack-js`. The build step is not decoration: `tsx` strips types without checking them, so nothing in the test command would notice a type error. **Trigger policy**: every PR; measured 11.8s for the suite and 1.2s for the build with dependencies installed.
- **`sdk-e2e`** (`.github/workflows/sdk-e2e.yml`) — runs `bash deploy/compose/sdk-evidence.sh` and nothing else: the SDK exit evidence, one command, from destroyed compose volumes (see "The SDKs" above for what it asserts). **Trigger policy**: every PR, same as every other check here, plus `workflow_dispatch`. Measured end to end on real runs of the job — ~3m43s (run [32050575928](https://github.com/Ziadabdelsalam/obstack/actions/runs/32050575928)) and ~3m44s (run [32052107372](https://github.com/Ziadabdelsalam/obstack/actions/runs/32052107372)) — comfortably under the ~6-minute line. A first policy set from a local 6m01s (destroyed volumes *and* an empty docker builder cache, on the machine described above) was corrected once the runner's own numbers existed: the deciding machine for a trigger policy is the runner. The `stack` job was left alone rather than extended, so no signed job's trigger policy depends on this one.

### Reproducing each check locally

```bash
# web — ClickHouse + ingest first (ingest applies the schema the
# ClickHouse-backed tests read), from the repo root
docker compose -f deploy/compose/docker-compose.yml up -d --wait --wait-timeout 120 clickhouse ingest
npm ci
CLICKHOUSE_URL=http://127.0.0.1:8123 CLICKHOUSE_USER=obstack_web CLICKHOUSE_PASSWORD=obstack_web_dev \
  npm test
npm run build
docker compose -f deploy/compose/docker-compose.yml down -v

# go — both databases first, from the repo root. CI runs Postgres as a service
# container rather than this compose service (it needs no mounted config, where
# ClickHouse needs deploy/compose's users.d), but the fixing values are the same
# down to the image pin, so the DSNs below are the ones CI carries.
docker compose -f deploy/compose/docker-compose.yml up -d --wait --wait-timeout 120 clickhouse postgres
cd services/ingest
gofmt -l .
go vet ./...
OBSTACK_TEST_CLICKHOUSE_DSN=clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack \
OBSTACK_TEST_CLICKHOUSE_READONLY_DSN=clickhouse://obstack_web:obstack_web_dev@127.0.0.1:9000/obstack \
OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
  go test -v -count=1 ./...
cd -
docker compose -f deploy/compose/docker-compose.yml down -v

# kind — needs Docker and a local `kind` + `kubectl`
docker build -t demo-agent:local demo/agent-app
kind create cluster --name kind-proof
kind load docker-image demo-agent:local --name kind-proof
sed 's#IMAGE_PLACEHOLDER#demo-agent:local#' .github/ci/kind-proof-workload.yaml | kubectl apply -f -
kubectl wait --for=condition=Ready pod/kind-proof-workload --timeout=120s
kind delete cluster --name kind-proof

# stack — needs Docker, kind, helm, kubectl, curl, and `npm ci` run once
kind create cluster --name obstack-stack
bash deploy/helm/obstack/acceptance.sh
kind delete cluster --name obstack-stack

# e2e — the two-stranger drive, from the repo root; needs Docker, `npm ci` run
# once, and Chrome on this machine. These are the three lines the job runs and
# the three deploy/compose/README.md documents ("The e2e drive").
docker compose -f deploy/compose/docker-compose.yml up -d --wait --wait-timeout 240
bash deploy/compose/smoke.sh
node deploy/compose/e2e-drive.mjs

# sdk-py — from the repo root (packages/obstack-py/README.md, "Development")
python -m venv .venv && source .venv/bin/activate
pip install -e './packages/obstack-py[fastapi]' -r ./packages/obstack-py/requirements-dev.txt
pytest packages/obstack-py

# sdk-js — from the repo root
npm ci
npm test --workspace packages/obstack-js
npm run build --workspace packages/obstack-js

# sdk-e2e — needs Docker and `npm ci` run once. Destroys the compose volumes
# and refuses to start if a container of this project is still up.
bash deploy/compose/sdk-evidence.sh
```

### Required checks (deliberately not enforced)

A red check does **not** block merge: branch protection cannot be set on this repository — both `PUT/GET /repos/:owner/:repo/branches/master/protection` and `/rulesets` return `403 Upgrade to GitHub Pro or make this repository public` while the repo is private on a personal plan. The decision (2026-08-16) is to **skip enforcement for now**: the checks run on every PR and are advisory; merges go through the project's review process instead. Revisit when the repo goes public or the plan changes.

If enforcement is ever enabled, on `master` (Settings → Branches → Add rule) require exactly these eight status checks by name — **`web`**, **`go`**, **`kind`**, **`stack`**, **`e2e`**, **`sdk-py`**, **`sdk-js`**, **`sdk-e2e`** — with "Require branches to be up to date before merging" (strict) enabled, admin enforcement off, no required approving reviews, and no push restrictions. All eight fire on every PR, which is the property that makes requiring them safe: a required check some PRs never fire blocks every one of them forever. The names are the workflow job names; renaming a job silently voids its required check, so they are fixed (K3).

## Documents

- Product spec: `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md`
- Vision/fundraising: `docs/superpowers/specs/2026-08-09-obstack-vision-prd.md`
- This phase's plan: `.planning/2026-08-09-phase0-frontend-prototype-plan.md`
- Screenshots: `docs/screenshots/`
