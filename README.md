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

Point your own service at `http://localhost:4318` (OTLP/HTTP) or `:4317` (gRPC) with `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20ok_dev_local` and its traces show up the same way. Details, users, schema and the manual verification checklist: `deploy/compose/README.md`.

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

**Pre-release: neither package is published.** There is nothing to
`pip install obstack-py` or `npm install obstack-js` from yet. Both install from
source, which is what the sample apps do:

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

Six checks run on every pull request against `master`: `web`, `go`, `kind`, `stack`, `sdk-py`, `sdk-js`. A seventh, `sdk-e2e`, is opt-in per PR and unconditional on `master` — see its bullet. Workflow definitions live in `.github/workflows/{web,go,kind,stack,sdk-py,sdk-js,sdk-e2e}.yml`. Making any of them *blocking* is branch protection, which is not configured yet — see "Required checks" below.

- **`web`** (`.github/workflows/web.yml`) — Node 24, the active-LTS major meeting Next 16.3's documented floor (20.9.0+, per `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`). Brings up ClickHouse **and `ingest`** via the same compose services local dev uses (ingest owns the schema, so a bare ClickHouse has no `obstack` database for the ClickHouse-backed tests to read), then runs `npm ci` against the committed `package-lock.json`, `npm test` (the tsx `node:test` runner) and `npm run build`. Like `go`, it fails on any unexpected test skip — the `node:test` runner's own skipped-count must be present and must agree with the skip lines the trap can see, so a self-skipping integration test cannot read as coverage it doesn't have. `setup-node`'s `cache: 'npm'` caches npm's package download cache only, keyed on `package-lock.json`; no `.next` build output is cached, because a cache keyed on `package-lock.json` alone would risk reusing prerenders across `OBSTACK_DATA_MODE` changes (the M1 F6 finding). CI therefore always builds from a clean checkout.
- **`go`** (`.github/workflows/go.yml`) — Go 1.25.4 (pinned in `services/ingest/go.mod`), anchored on `services/ingest`. Brings up ClickHouse via the same compose service local dev uses, then runs `gofmt -l`, `go vet ./...` and `go test -v -count=1 ./...` against it, carrying the two D11 users (`obstack_ingest` write, `obstack_web` readonly). `-count=1` is load-bearing — without it, Go can replay a cached package result from `GOCACHE` and report "PASS" without ever contacting ClickHouse. Any `--- SKIP` in the test output fails the job: a ClickHouse-dependent test that can't reach a server errors instead of silently skipping and reading as coverage it doesn't have.
- **`kind`** (`.github/workflows/kind.yml`) — builds the demo agent image (`demo/agent-app/Dockerfile`) tagged with the commit SHA, creates a kind cluster, loads that image in (`imagePullPolicy: Never` makes a registry fallback impossible), and applies the proof workload (`.github/ci/kind-proof-workload.yaml`). After the pod reports Ready, the job waits for it to emit real telemetry against a deliberately black-holed OTLP endpoint and confirms it stayed `Running`/`Ready` anyway — proving the OpenTelemetry SDK's fail-open property, not just that the container started. **Trigger policy**: runs on every PR, same as `web` and `go` — there is no label or manual trigger, so opening a PR or pushing to its branch is what fires it. Measured end-to-end wall-clock (job start to cluster teardown) is ~1m37s (run [31933353051](https://github.com/Ziadabdelsalam/obstack/actions/runs/31933353051)), well under the ~6-minute line the trigger policy is decided on — past that line the job would move to a `ci:kind` label + push-to-`master` + `workflow_dispatch` trigger and drop out of the required-checks set rather than leave a required check some PRs never fire.
- **`stack`** (`.github/workflows/stack.yml`) — stands the whole stack up on a kind cluster through the real Helm chart (`deploy/helm/obstack/`, the only kind path — D35) by running `deploy/helm/obstack/acceptance.sh`, the exact script the chart README tells a human to run. It drives one `POST /chat` at the demo app and asserts the sprint's correlation evidence through the tsx facade harness against the cluster's ClickHouse: the four-layer waterfall, ≥1 solid log row with pod metadata, ≥1 nearby row from the uninstrumented sidecar, and zero duplicated bodies. **Trigger policy**: every PR, same as the other three — measured wall-clock is ~4m (e.g. run [31962751881](https://github.com/Ziadabdelsalam/obstack/actions/runs/31962751881)), under the same ~6-minute line; past it the job moves to a `ci:stack` label + push-to-`master` + `workflow_dispatch` and drops out of the required-checks set.

- **`sdk-py`** (`.github/workflows/sdk-py.yml`) — Python 3.14; runs `packages/obstack-py`'s "Development" block verbatim: a venv, one editable install with the `[fastapi]` extra plus the exactly-pinned `requirements-dev.txt`, then `pytest packages/obstack-py`. Split from `sdk-js` rather than combined so a red check names the language at fault. It does not build a wheel — `sdk-e2e` does, because the sample's image installs the package for real. **Trigger policy**: every PR; measured 18.0s with a warm pip cache and 34.8s with an empty one (Apple M4, 10 cores, Python 3.14.6), far under the ~6-minute line.
- **`sdk-js`** (`.github/workflows/sdk-js.yml`) — Node 24; `npm ci`, then `npm test --workspace packages/obstack-js` (the repo's `tsx --test` / `node:test` runner, 42 tests driving the real `openai`, `@anthropic-ai/sdk` and `ai` clients against local fakes) and `npm run build --workspace packages/obstack-js`. The build step is not decoration: `tsx` strips types without checking them, so nothing in the test command would notice a type error. **Trigger policy**: every PR; measured 11.8s for the suite and 1.2s for the build with dependencies installed.
- **`sdk-e2e`** (`.github/workflows/sdk-e2e.yml`) — runs `bash deploy/compose/sdk-evidence.sh` and nothing else: the SDK exit evidence, one command, from destroyed compose volumes (see "The SDKs" above for what it asserts). **Trigger policy**: *not* every PR. Measured 6m01s from destroyed volumes with the three service images rebuilt from an empty builder cache (69s when they are already built), on the machine described above and before a runner's checkout, `npm ci` and image pulls — at the ~6-minute line rather than under it. So it takes D41's other branch whole: add the **`ci:sdk-e2e`** label to a PR to run it there, it always runs on push to `master` (a red there is stop-the-line for the next PR), and `workflow_dispatch` runs it on demand. It is deliberately not in the required set — a required check that only some PRs fire is worse than an honest opt-in one. The `stack` job was left alone rather than extended, so no signed job's trigger policy depends on this one.

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

# go — ClickHouse first, from the repo root
docker compose -f deploy/compose/docker-compose.yml up -d --wait --wait-timeout 120 clickhouse
cd services/ingest
gofmt -l .
go vet ./...
OBSTACK_TEST_CLICKHOUSE_DSN=clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack \
OBSTACK_TEST_CLICKHOUSE_READONLY_DSN=clickhouse://obstack_web:obstack_web_dev@127.0.0.1:9000/obstack \
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

If enforcement is ever enabled, on `master` (Settings → Branches → Add rule) require exactly these six status checks by name — **`web`**, **`go`**, **`kind`**, **`stack`**, **`sdk-py`**, **`sdk-js`** — with "Require branches to be up to date before merging" (strict) enabled, admin enforcement off, no required approving reviews, and no push restrictions. **`sdk-e2e` is deliberately excluded**: it runs only on labelled PRs, and a required check that most PRs never fire blocks every one of them forever. The names are the workflow job names; renaming a job silently voids its required check, so they are fixed (K3).

## Documents

- Product spec: `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md`
- Vision/fundraising: `docs/superpowers/specs/2026-08-09-obstack-vision-prd.md`
- This phase's plan: `.planning/2026-08-09-phase0-frontend-prototype-plan.md`
- Screenshots: `docs/screenshots/`
