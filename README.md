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

## What's real vs. mock

Everything visual is real code (Next.js + Tailwind + Recharts). With `OBSTACK_DATA_MODE=live` the traces list, the trace view, the logs explorer (`/app/logs`) and the overview charts read ingested telemetry from ClickHouse; every surface not yet wired to the pipeline is marked with a `SAMPLE DATA` badge in the UI. The logs explorer searches a bounded, capped window of the `logs` table and refreshes when you ask it to — nothing on any surface tails or polls. In the default mock mode all data is fictional, generated deterministically in `apps/web/src/mock/` — including three scripted failure stories that demonstrate cross-layer correlation (pod OOM-kill → truncated completion → 502; tool-timeout retry chain; provider rate-limit cascade).

## CI

Four checks run on every pull request against `master`: `web`, `go`, `kind`, `stack`. Workflow definitions live in `.github/workflows/{web,go,kind,stack}.yml`. Making them *blocking* is branch protection, which is not configured yet — see "Required checks" below.

- **`web`** (`.github/workflows/web.yml`) — Node 24, the active-LTS major meeting Next 16.3's documented floor (20.9.0+, per `node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`). Brings up ClickHouse **and `ingest`** via the same compose services local dev uses (ingest owns the schema, so a bare ClickHouse has no `obstack` database for the ClickHouse-backed tests to read), then runs `npm ci` against the committed `package-lock.json`, `npm test` (the tsx `node:test` runner) and `npm run build`. Like `go`, it fails on any unexpected test skip — the `node:test` runner's own skipped-count must be present and must agree with the skip lines the trap can see, so a self-skipping integration test cannot read as coverage it doesn't have. `setup-node`'s `cache: 'npm'` caches npm's package download cache only, keyed on `package-lock.json`; no `.next` build output is cached, because a cache keyed on `package-lock.json` alone would risk reusing prerenders across `OBSTACK_DATA_MODE` changes (the M1 F6 finding). CI therefore always builds from a clean checkout.
- **`go`** (`.github/workflows/go.yml`) — Go 1.25.4 (pinned in `services/ingest/go.mod`), anchored on `services/ingest`. Brings up ClickHouse via the same compose service local dev uses, then runs `gofmt -l`, `go vet ./...` and `go test -v -count=1 ./...` against it, carrying the two D11 users (`obstack_ingest` write, `obstack_web` readonly). `-count=1` is load-bearing — without it, Go can replay a cached package result from `GOCACHE` and report "PASS" without ever contacting ClickHouse. Any `--- SKIP` in the test output fails the job: a ClickHouse-dependent test that can't reach a server errors instead of silently skipping and reading as coverage it doesn't have.
- **`kind`** (`.github/workflows/kind.yml`) — builds the demo agent image (`demo/agent-app/Dockerfile`) tagged with the commit SHA, creates a kind cluster, loads that image in (`imagePullPolicy: Never` makes a registry fallback impossible), and applies the proof workload (`.github/ci/kind-proof-workload.yaml`). After the pod reports Ready, the job waits for it to emit real telemetry against a deliberately black-holed OTLP endpoint and confirms it stayed `Running`/`Ready` anyway — proving the OpenTelemetry SDK's fail-open property, not just that the container started. **Trigger policy**: runs on every PR, same as `web` and `go` — there is no label or manual trigger, so opening a PR or pushing to its branch is what fires it. Measured end-to-end wall-clock (job start to cluster teardown) is ~1m37s (run [31933353051](https://github.com/Ziadabdelsalam/obstack/actions/runs/31933353051)), well under the ~6-minute line the trigger policy is decided on — past that line the job would move to a `ci:kind` label + push-to-`master` + `workflow_dispatch` trigger and drop out of the required-checks set rather than leave a required check some PRs never fire.
- **`stack`** (`.github/workflows/stack.yml`) — stands the whole stack up on a kind cluster through the real Helm chart (`deploy/helm/obstack/`, the only kind path — D35) by running `deploy/helm/obstack/acceptance.sh`, the exact script the chart README tells a human to run. It drives one `POST /chat` at the demo app and asserts the sprint's correlation evidence through the tsx facade harness against the cluster's ClickHouse: the four-layer waterfall, ≥1 solid log row with pod metadata, ≥1 nearby row from the uninstrumented sidecar, and zero duplicated bodies. **Trigger policy**: every PR, same as the other three — measured wall-clock is ~4m (e.g. run [31962751881](https://github.com/Ziadabdelsalam/obstack/actions/runs/31962751881)), under the same ~6-minute line; past it the job moves to a `ci:stack` label + push-to-`master` + `workflow_dispatch` and drops out of the required-checks set.

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
```

### Required checks (deliberately not enforced)

A red check does **not** block merge: branch protection cannot be set on this repository — both `PUT/GET /repos/:owner/:repo/branches/master/protection` and `/rulesets` return `403 Upgrade to GitHub Pro or make this repository public` while the repo is private on a personal plan. The decision (2026-08-16) is to **skip enforcement for now**: the checks run on every PR and are advisory; merges go through the project's review process instead. Revisit when the repo goes public or the plan changes.

If enforcement is ever enabled, on `master` (Settings → Branches → Add rule) require exactly these four status checks by name — **`web`**, **`go`**, **`kind`**, **`stack`** — with "Require branches to be up to date before merging" (strict) enabled, admin enforcement off, no required approving reviews, and no push restrictions. The names are the workflow job names; renaming a job silently voids its required check, so they are fixed (K3).

## Documents

- Product spec: `docs/superpowers/specs/2026-08-09-obstack-execution-prd.md`
- Vision/fundraising: `docs/superpowers/specs/2026-08-09-obstack-vision-prd.md`
- This phase's plan: `.planning/2026-08-09-phase0-frontend-prototype-plan.md`
- Screenshots: `docs/screenshots/`
