# Deploy Plan — obstack M4 ship (S5): the cloud SaaS, the public demo and the docs site live on Railway under obstack.dev from the S4 images — a stranger reaches `/signup` over the public internet, the Polar rail runs in production, and the first 5 design partners are activated

meta:
- date: 2026-08-31
- shipping: master @ `2819a91` (code tip `f7b9dd0`, PR #24 merge; `2819a91` is a planning-only commit on top)
- provider: **Railway for everything** (U10, user 2026-08-31) | environment: Railway `staging` environment (Railway-issued domains) → `production` environment (custom domains)
- domain: **obstack.dev** (U11, user 2026-08-31; owned — parked on Squarespace DNS, `nsc1-4.squarespacedns.com`, apex A → Squarespace parking IPs; `app.`/`ingest.` unresolved)
- registry: **GHCR** (proposed, advisor to ratify — §Advisor decisions) | images: `ghcr.io/ziadabdelsalam/obstack-web:{live,mock}-<sha>`, `ghcr.io/ziadabdelsalam/obstack-ingest:<sha>`
- mode: waves
- team-cap: 8
- models: executor=sonnet reviewer=opus advisor=fable (Step 0 defaults confirmed by the user; effort per the standing policy — executors `high`, reviewers/advisor `xhigh`)
- iteration-limit: 3 — fix rounds allowed before escalating to the user
- iteration: 0/3
- user round (2026-08-31, Step 0 addendum): **K0 QA gate = qa-team pass on the Railway staging environment BEFORE the production DNS cut-over** (a new ship-sequence gate, §Ship sequence); **T4 executor = Opus 5 (one-task exception, user-approved)**; **K5 Explain = `fake` + an honest absence sentence on the hosted Explain surface** (no key ships; new task T9); **K9/U12 monitor = Better Stack** (user's account; T5 shaped for its public status page/badge).
- prior gates: S4.4 integrator **FIXED-GO** (`b7310ef`), advisor **SIGNED WITH CONDITIONS** (effective `ce2e61e`), post-signature §8 cluster events green in CI (run 4 `76ce878`), PR #24 merged, master `stack` green on the merge commit (10m49s). QA: no qa-team run was dispatched for S4.4 (S4.x used reviewer×2 + integrator gates; the S3.3 QA addendum is the last qa-team verdict) — recorded here, user decision at kickoff (§Kickoff questions K0).
- planning record: this file lives in `.planning/` by project convention (every sprint's plan is here); it IS the deploy-team plan file agents parse.

## Topology (D262 dual-build + U10 — the target the tasks build toward)

| Railway service | image | public | private | volume | env (names only) |
|---|---|---|---|---|---|
| `marketing` | `obstack-web:mock-<sha>` built with `OBSTACK_APP_ORIGIN=https://app.obstack.dev` (D329 — baked at prerender) | `obstack.dev`, `www.obstack.dev` → :3000 | — | — | `OBSTACK_DATA_MODE=mock` |
| `web` | `obstack-web:live-<sha>` | `app.obstack.dev` → :3000 | → clickhouse:8123, postgres:5432 | — | `OBSTACK_DATA_MODE=live`, `CLICKHOUSE_URL`, `CLICKHOUSE_USER=obstack_web`, `CLICKHOUSE_PASSWORD`, `OBSTACK_POSTGRES_DSN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://app.obstack.dev` (D119), `OBSTACK_BILLING_MODE`, `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `OBSTACK_APP_URL`, `POLAR_PRODUCT_PRO` (D177 five + product), `OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT`, `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT` (D101/D266/D277), `OBSTACK_EXPLAIN_MODE`, `OBSTACK_EXPLAIN_API_KEY`/`ANTHROPIC_API_KEY`, `OBSTACK_EXPLAIN_MODEL`, `OBSTACK_EXPLAIN_BASE_URL` |
| `ingest` | `obstack-ingest:<sha>` (distroless, nonroot) — **1 replica** (compose README: "exactly one migration runner per upgrade"; both migration sets are ingest's DDL) | `ingest.obstack.dev` → :4318 (OTLP/HTTP + `/v1/integrations/{vercel,cloudwatch}`); gRPC :4317 per the Railway multi-port fact (§Measured, R1) | → clickhouse:9000, postgres:5432; admin :8080 private only (`/healthz`, `/metrics`) | — | `CLICKHOUSE_DSN` (user `obstack_ingest`), `OBSTACK_POSTGRES_DSN`, `OBSTACK_VERCEL_DRAIN_SECRET`, `OBSTACK_OTLP_GRPC_ADDR`/`OBSTACK_OTLP_HTTP_ADDR`/`OBSTACK_ADMIN_ADDR` (defaults) |
| `clickhouse` | `clickhouse/clickhouse-server:26.3.17.110` **+ the two-user `users.d` file** (compose mounts `deploy/compose/clickhouse/users.d/obstack-users.xml`; Railway mounts no repo files → a one-`COPY` derived image, T3) | — | :8123, :9000 | `/var/lib/clickhouse` | `OBSTACK_CLICKHOUSE_INGEST_PASSWORD`, `OBSTACK_CLICKHOUSE_WEB_PASSWORD` |
| `postgres` | `postgres:17.11` (the pinned image compose/chart use — NOT Railway's template, same-images/DDL parity) | — | :5432 | `/var/lib/postgresql/data` | `POSTGRES_USER=obstack`, `POSTGRES_PASSWORD`, `POSTGRES_DB=obstack` |

Not deployed: the collector (customers export from their side; the D101 endpoint is `ingest.obstack.dev`), the demo agent and SDK samples (the public demo IS the mock build, D262 — a live seeded demo was refused), the k8s events receiver (no cluster API on Railway — the S4.4 §8 "on Kubernetes only" truth holds; the landing-is-spec ruling stands).

## Measured facts (intake 2026-08-31 — measured, never believed)

- **M1 — no production billing rail exists in code.** `apps/web/src/server/billing/client.ts:28-30`: `OBSTACK_BILLING_MODE` must be `"fake"` or `"polar-sandbox"`; `polar.ts:82` hard-codes `server: "sandbox"` (→ `sandbox-api.polar.sh`); `polar.ts:49` errors name `polar-sandbox` literally. The D173.5 promotion is therefore a **code change** (a production mode on the same D110 module), not an env flip. D178 does not fire (no `@polar-sh/sdk` bump).
- **M2 — images are built, never published.** `.github/workflows/images.yml` builds `obstack-web:{live,mock}` + `obstack-ingest:ci` and runs the refusal matrix; there is no `docker login`/push step and no registry anywhere in the repo; chart values default to `obstack-web:kind` `pullPolicy: Never`. The operator's `gh` token scopes are `gist, read:org, repo, workflow` — **no `write:packages`/`read:packages`** (`gh api user/packages` → 403). Repo is **PRIVATE** → GHCR packages inherit private → Railway needs a read credential.
- **M3 — `/signup` has no explicit abuse control.** `apps/web/src/server/auth.ts:28` `emailAndPassword: { enabled: true, requireEmailVerification: false }`; no `rateLimit`, no `trustedOrigins`, no captcha anywhere under `apps/web/src` (mock-only matches). better-auth's own default limiter behaviour in `NODE_ENV=production` is to be read from the vendored package docs at breakdown, not assumed (S3 plan `:598` pre-registered risk).
- **M4 — the `/status` monitoring slot is a pinned sentence.** `apps/web/src/app/status/page.tsx:137-141` renders "External uptime monitoring begins at launch; this page shows no uptime numbers until then." and `status.test.ts:226-231` pins it verbatim (D256). Wiring U12 = copy + test + whatever the monitor exposes (badge/embed/link) — a code edit inside the deploy sprint.
- **M5 — the two SOON cards are `status: "coming-soon"` literals** in `apps/web/src/components/connections/connectors.ts` (Vercel `:151-153`, AWS CloudWatch Logs `:160-162`); D208 makes availability a product claim in both modes; **D285 gates each flip on a real wire capture** re-validated against the fixture (fix-before-flip). Ingest routes exist: `POST /v1/integrations/vercel`, `/v1/integrations/cloudwatch` (`receive/http.go:76-77`), behind the D98 bearer path.
- **M6 — the D177 inventory as shipped:** `OBSTACK_BILLING_MODE` · `POLAR_ACCESS_TOKEN` (`polar_oat_…`) · `POLAR_WEBHOOK_SECRET` (Standard Webhooks base64) · `OBSTACK_APP_URL` (`polar.ts:89` — absolute success URL) · `POLAR_PRODUCT_<PLAN>` (`POLAR_PRODUCT_PRO`, a **production** product id — "a sandbox product id means nothing in production", `polar.ts:38`). Webhook endpoint: `https://app.obstack.dev/api/billing/webhook` (`app/api/billing/webhook/route.ts`). D200 consequence: unreachable webhooks leave rail-originated revocations unapplied until a return-path reconcile that may never come.
- **M7 — `OBSTACK_APP_ORIGIN` is a build ARG, refuses malformed values at `next build`** (`lib/app-href.ts:50-70`; `apps/web/Dockerfile:52-53`). The marketing image is therefore built once per app origin — the mock variant CI builds today has it unset (relative hrefs → the dead-end `/signup`, exactly what the helper routes around). **The mock image for obstack.dev must be a separate build with the ARG set.**
- **M8 — Explain is `fake` unless `OBSTACK_EXPLAIN_MODE=anthropic`** (`explain/client.ts:19-21`) with `ANTHROPIC_API_KEY`/`OBSTACK_EXPLAIN_*`. `fake` in production is a fiction on a shipped surface — a user-supplied key or an honest absence sentence; kickoff question K5.
- **M9 — carried copy (S4.4 §7 "to S5")**: "an obstack you run" ×3 on `/` (`page.tsx:157,162,550`) + invite page `:172`; "+ usage" (`page.tsx:446`, L77 — the Polar unit price); "installed from this repo today" (`page.tsx:395`, L71 — flips only on an SDK publish); OG image / `robots` / `sitemap` / `manifest` absent under `apps/web/src/app` (M3). The 2026-08-31 landing-is-spec ruling says no copy edits *until the backend covers the claim* — the hosting flip is the backend covering "signing up creates a workspace on an obstack you run"; kickoff question K6.
- **M10 — operator prerequisites:** Railway CLI not installed; Railway account/project state unknown; DNS is at Squarespace (apex CNAME limits → Railway fact R10); U12–U16 state **unknown to the user** (answer 2026-08-31) → each is a verify-or-block gate below, never assumed.
- **M11 — the ingest listens on `:4317` gRPC, `:4318` HTTP, `:8080` admin** (`config.go:70-72`, env-overridable); `/ingest healthcheck` subcommand probes admin `/healthz` (`main.go:45-51`); distroless image has no shell/curl. Web has no `/healthz` route — CI probes `GET /login` (`images.yml:106`), the mock probe `GET /app` (`:89`).
- **M12 — Railway platform facts:** in `<scratchpad>/railway-facts.md` (research agent, official docs only, quoted) — folded into R1–R14 below when it lands; **nothing in the tasks may rest on a Railway behaviour that file marks "not documented".**

## Railway facts (R1–R14 — official docs only, quoted in `<scratchpad>/railway-facts.md`; copied to `.planning/2026-08-31-s5-railway-facts.md`)
- **R1 multi-port domains: YES** — one service, many custom domains, each with its own Target Port (`railway domain <host> --port <n>`). `ingest.obstack.dev→4318` + `ingest-grpc.obstack.dev→4317` is expressible.
- **R2 gRPC/HTTP2 through the edge proxy: NOT DOCUMENTED** either way; the only documented protocol-agnostic path is the TCP Proxy, which yields `*.proxy.rlwy.net:PORT`, not a custom domain. → gRPC on a custom domain must be proven live on staging or the launch is HTTP-only with `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT` unset (K4).
- **R3 private networking:** `<service>.railway.internal`; **unavailable during builds**; environments created after 2025-10-16 are dual-stack (older: IPv6-only).
- **R4 volumes:** one per service; **a volume-backed service cannot run replicas**; mount path configurable; redeploys preserving data is implied, not stated (Unknown 3).
- **R5 private registry (GHCR): supported, PRO-PLAN-GATED** ("Private registry credentials are available on the Pro plan"); a PAT with `read:packages`. `railway redeploy` re-pulls the configured reference → deploy by changing the image reference to the new immutable `sha-` tag, never by moving a mutable tag. **Rollback is dashboard-only** (no CLI command documented, Unknown 7); retention window unnumbered (Unknown 8).
- **R6 Dockerfile builds:** `RAILWAY_DOCKERFILE_PATH` + Root Directory per service; service variables are exposed as build ARGs. (Fallback to K1(b) if GHCR is refused.)
- **R7 CLI:** Homebrew install; browser login or `RAILWAY_TOKEN` (project) vs `RAILWAY_API_TOKEN` (account); `railway link`, `railway variable set` (Unknown 6: `variables --set` spelling), `railway domain`, `railway up`/`redeploy`, `railway logs`.
- **R8 config-as-code:** `railway.json`/`.toml` per service via an absolute repo path in service settings; fields: builder, dockerfilePath, startCommand, healthcheckPath/Timeout, restartPolicy, numReplicas, region.
- **R9 healthchecks:** `healthcheckPath` on the service's port; new deployment must pass before the old is retired (zero-downtime shape as documented).
- **R10 DNS/TLS:** automatic certificates; subdomains via CNAME; apex needs ALIAS/ANAME or flattening — **Squarespace apex: RESOLVED (official docs, `.planning/2026-08-31-s5-squarespace-dns-facts.md`)** — Squarespace DNS supports an **ALIAS** record at `@` pointing at an external hostname (the Railway `*.up.railway.app` target); DNSSEC must be off and the default parking A records deleted first (ALIAS conflicts with A/AAAA on the same name; whether Squarespace re-adds them is not documented → verify after the cut-over). `@` cannot be a CNAME; subdomain CNAMEs are ordinary. Nameserver change to another DNS host is allowed without a lock; a registrar transfer-away carries a 60-day lock (irrelevant — not needed). Default TTL 4h — lower it ahead of the cut-over.
- **R11 pricing (fetched 2026-08-31, page undated):** Hobby $5/mo, Pro $20/mo; **Hobby custom-domain support not stated (Unknown 4)**; Pro required for R5 regardless.
- **R12 datastores:** ClickHouse = marketplace template (not officially maintained); Postgres docs bless running your own image instead of the managed template → own pinned images (K7) is doc-sanctioned.
- **R13 regions:** four, per-service (EU present). **R14 sleeping:** only if a service opts into "Serverless" — always-on by default (ingest safe).

## Advisor decisions
<!-- filled at kickoff (Step 2); D-numbers continue the project ledger from D331 -->

## Kickoff questions for the advisor
- **K0 — QA gate.** No qa-team run exists for S4.x (reviewer×2 + integrator was the S4 shape). Rule: ship on the S4 gates as recorded, or require a qa-team pass on the staging environment before production (recommendation: a staging-environment QA charter IS the smoke suite — one pass, adversarial on `/signup` + the ingest key path, before DNS flips).
- **K1 — image flow.** (a) CI pushes to GHCR on master (`images.yml` gains `packages: write` + a push step keyed by sha; no operator scope needed) and Railway pulls with a read-only PAT; or (b) Railway builds from the repo Dockerfiles (build args from service variables — R6). Same-images honesty favours (a): the digest Railway runs is the digest CI proved. Rollback = previous sha tag. Recommendation (a).
- **K2 — the production billing mode (M1).** Name it (`polar` / `polar-production`), same D110 module, `server: "production"`; tests mirror the sandbox arms; error strings generalised. Executor tier: this is a code change under the D110 boundary — propose Opus for T4 (Step 0 default is Sonnet; the skill allows a per-task bump with the user's one-line approval).
- **K3 — `/signup` abuse controls (M3).** better-auth's limiter measured from the vendored docs; rule the minimum: explicit `rateLimit` config (window/max, a stricter `customRules` entry for `/sign-up/email`) + `trustedOrigins` for the two hosts — or refuse and accept the risk in writing. No captcha in M4 unless ruled.
- **K4 — ingest exposure shape.** Public :4318 on `ingest.obstack.dev`; gRPC :4317 per R1/R2 (second domain on :4317, or HTTP-only launch with `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT` unset — the ConnectModal already renders the honest absence, `ConnectModal.tsx:34`). Admin :8080 never public.
- **K5 — Explain in production (M8). USER-DECIDED: `fake` + honest absence.** Advisor rules the sentence's site and shape (the Explain surface + docs), the D168 consequence, and whether the mock marketing page's Explain claims need a fence row.
- **K6 — the carried copy (M9).** Which sentences flip in S5 under the landing-is-spec ruling; OG/robots/sitemap/manifest in or out; "+ usage" needs the Polar production unit price (user); "installed from this repo today" stays unless an npm/PyPI publish is ruled into S5 (recommendation: OUT — a publish is its own outward-facing act with a version story).
- **K7 — Postgres/ClickHouse on Railway.** Own pinned images with volumes (topology above) vs Railway's Postgres template. Recommendation: own images — the chart and compose pin `postgres:17.11`/`26.3.17.110`, and ingest's DDL was proven against those. Backups: Railway volume snapshots per R4, or refuse-and-record.
- **K8 — staging → production.** Two Railway environments in one project, staging on Railway domains with `BETTER_AUTH_URL` = the Railway domain and Polar sandbox; production on custom domains with the production rail. Smoke on staging = the S4.4 D38(e) walk against the hosted facade (signup → key → OTLP POST → trace with cost) — reuse `deploy/compose/smoke.ts`/`trace-checks.ts` shapes or a new `deploy/railway/smoke.ts`.
- **K9 — U12 monitor. USER-DECIDED: Better Stack.** Advisor rules what T5 may render (status-page link vs embedded badge — an embed is third-party script on `/status`), and the check set (three hosts + an ingest probe).

## Critical items (advisor sign-off + user confirmation before the manager executes)
- **DNS cut-over at Squarespace** (apex + `www` + `app` + `ingest`) — outward-facing, replaces the parked records.
- **First production deploy of each service** — user confirmation immediately before, every time.
- **Polar sandbox → production promotion (D173.5)**: production org verification (U14), production `polar_oat_` token, production product id, webhook endpoint registered at `https://app.obstack.dev/api/billing/webhook` with its secret, then `OBSTACK_BILLING_MODE` flipped; D104 exit clauses re-verified against the production rail (a real checkout, a real webhook delivery, the D200 revocation path exercised once).
- **SOON-card flips (D101/D285)** — only after a real Vercel drain delivery and a real CloudWatch subscription delivery are captured on `ingest.obstack.dev` and re-validated against the fixtures.
- **GHCR first push** (new registry namespace) and any Railway project creation.
- **Design-partner activation** — user act; the S5 exit clause.

## Secrets checklist
<!-- Names only. NEVER values. -->
| name | needed by | source | store |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | web | `openssl rand -base64 32` (user) | Railway variables (web) |
| `OBSTACK_POSTGRES_PASSWORD` → `POSTGRES_PASSWORD` + both DSNs | postgres, web, ingest | generated (user) | Railway variables (shared reference) |
| `OBSTACK_CLICKHOUSE_INGEST_PASSWORD` / `OBSTACK_CLICKHOUSE_WEB_PASSWORD` | clickhouse, ingest, web | generated (user) | Railway variables |
| `POLAR_ACCESS_TOKEN` (production `polar_oat_…`) | web | Polar dashboard (user, U14) | Railway variables (web) |
| `POLAR_WEBHOOK_SECRET` | web | Polar webhook endpoint (user) | Railway variables (web) |
| `POLAR_PRODUCT_PRO` (production product id — not a secret, environment-bound) | web | Polar catalog (user) | Railway variables (web) |
| `OBSTACK_VERCEL_DRAIN_SECRET` (optional) | ingest | Vercel drain settings (user) | Railway variables (ingest) |
| `ANTHROPIC_API_KEY` / `OBSTACK_EXPLAIN_API_KEY` (K5) | web | user | Railway variables (web) |
| GHCR read token for Railway image pulls | Railway | fine-grained PAT `read:packages` (user) | Railway registry credentials |
| `GITHUB_TOKEN` `packages: write` | `images.yml` push job | GitHub-provided | workflow `permissions:` block |
| `RAILWAY_TOKEN` (project token) — only if CI deploys; otherwise the operator's CLI login | CI / operator | Railway (user) | `gh secret set` / keychain |
| Squarespace DNS login | manager (with user) | user | — (never in repo) |

## Tasks
<!-- Draft; the advisor may restructure at kickoff. Executors receive this path + one ID. -->

### T0: operator prerequisites (manager + user; no agent)
- status: executing — 2026-08-31: Railway CLI 5.45.10 installed (Homebrew); operator logged in as **hi@obstack.dev** (the product account — an earlier login as the personal Outlook account was superseded; its `impartial-tenderness` project is unrelated and untouched); the obstack workspace has NO projects yet; plan tier unverified (Pro needed for R5). Squarespace apex resolved (R10). Open: Railway plan, GHCR read PAT, Better Stack (U12), Polar org verification (U14), design partners (U13).
- owns: — (accounts, CLI, scopes)
- done-check: `railway whoami` succeeds; Railway project exists (staging + production environments); `gh auth status` unchanged (CI does the push); a `read:packages` PAT exists for Railway; Squarespace DNS editable; **U12** monitor account named or BLOCK T5; **U14** Polar org verification status known or BLOCK the promotion critical item; **U13** design-partner list exists or the exit clause is recorded open; **U16** GCP application irrelevant under U10=Railway (record); **U15** launch without email (recommendation) recorded.
- result:

### T1: image publish job — `images.yml` pushes to GHCR on master
- status: pending
- owns: `.github/workflows/images.yml` (+ `deploy/README.md` registry paragraph if one exists)
- playbook: GitHub repo & CI; Docker + registry
- done-check: `actionlint` clean; the push step is gated `github.ref == 'refs/heads/master'`; tags `sha-<sha>` + `master`; `permissions: packages: write` on that job only; the mock variant is built TWICE or parameterised — the published `mock` tag carries `OBSTACK_APP_ORIGIN=https://app.obstack.dev` (M7) and the refusal matrix still runs on the unset build; D41 backstop (`cancel-in-progress` never on master) untouched.
- result:

### T2: Railway config-as-code + runbook — `deploy/railway/`
- status: pending
- owns: `deploy/railway/README.md`, per-service `railway.json` (R8), `deploy/railway/.env.example` (names only, mirrors compose's), `deploy/railway/smoke.ts` (K8)
- playbook: Fly.io / Railway / plain VPS; Docker + registry
- done-check: every name in §Topology appears once in the env example with its source; `railway.json` validates against the schema URL; smoke script runs against a URL triple (`MARKETING_URL`, `APP_URL`, `INGEST_URL`) and exits non-zero on any failed probe — proven red against a wrong URL.
- result:

### T3: ClickHouse image for Railway — `deploy/railway/clickhouse/Dockerfile`
- status: pending
- owns: `deploy/railway/clickhouse/Dockerfile` (+ `.dockerignore`), reusing `deploy/compose/clickhouse/users.d/obstack-users.xml` by `COPY` (single source — no second copy of the XML)
- playbook: Docker + registry
- done-check: `docker build` from the repo root; `docker run` with the two passwords → `SELECT 1` succeeds as `obstack_ingest` and `obstack_web`, `obstack_web` cannot `CREATE` (the read-only grant holds); image published by T1 as `obstack-clickhouse:<sha>`.
- result:

### T4: production billing mode (M1, D173.5) — executor Opus 5 (user-approved one-task exception)
- status: pending
- owns: `apps/web/src/server/billing/client.ts`, `apps/web/src/server/billing/polar.ts`, their tests, `deploy/compose/.env.example` + chart values comment lines that name `polar-sandbox`, the docs page that documents `OBSTACK_BILLING_MODE`
- playbook: —
- done-check: `OBSTACK_BILLING_MODE=polar` selects `server: "production"` on the same module; sandbox arm unchanged; tests cover both; `grep -rn 'polar-sandbox'` finds only the sandbox arm and its docs; typecheck + `apps/web` tests green; D110 boundary intact (still the ONLY module that calls Polar).
- result:

### T5: `/status` monitor wiring (U12 = Better Stack, D256, M4)
- status: pending (BLOCKED on T0: the Better Stack status page must exist to be linked)
- owns: `apps/web/src/app/status/page.tsx`, `status.test.ts`, the `/status` docs sentence if any
- done-check: the monitoring section renders the monitor's real public artefact (link/badge) and the pinned sentence is replaced by a sentence the test derives from the monitor URL env (`OBSTACK_STATUS_MONITOR_URL`, unset = the current sentence, so compose/chart keep the truth); fence 8/8 still green.
- result:

### T6: SOON-card flips (D101/D285/D208)
- status: pending (BLOCKED on the two real captures — post-deploy)
- owns: `apps/web/src/components/connections/connectors.ts` (Vercel `:151-153`, CloudWatch `:160-162`), the D208 tests, the connectors docs page
- done-check: each flip commit cites the capture (delivery id, timestamp, `ingest.obstack.dev` log line) and the fixture re-validation; flips are separate commits so one can land without the other.
- result:

### T7: launch copy under hosting (K6 ruling) + OG/robots/sitemap/manifest
- status: pending (scope ruled at kickoff)
- owns: `apps/web/src/app/page.tsx` (`:157,:162,:395,:446,:550`), `apps/web/src/app/invite/[id]/page.tsx:172`, `apps/web/src/app/{robots,sitemap,manifest}.ts`, `opengraph-image`, the S4.4 landing fence rows they touch (`.planning/2026-08-30-s4.4-landing-fence.md`)
- done-check: fence tests updated in the same commit; rendered-bytes sweep green in both modes; `curl https://obstack.dev/robots.txt` after deploy.
- result:

### T8: signup abuse controls (K3 ruling)
- status: pending (scope ruled at kickoff)
- owns: `apps/web/src/server/auth.ts` (+ a test proving the limiter refuses the N+1th sign-up from one IP inside the window — proven red first)
- done-check: the limiter's storage and window are named in `deploy/railway/README.md`; `trustedOrigins` carries exactly the two hosts.
- result:

### T9: Explain honest absence on the hosted app (K5)
- status: pending (advisor shapes at kickoff)
- owns: the Explain surface component + its test, the Explain docs page sentence
- done-check: with `OBSTACK_EXPLAIN_MODE=fake` in `live` data mode the surface says Explain is not enabled on this deployment (no fabricated explanation renders); compose/chart truth unchanged (they already run `fake` by default — the sentence must be true there too).
- result:

## Ship sequence (Step 5, gated)
1. branch `s5-ship` → PR: T1 T2 T3 T4 T7 T8 T9 (T5 once the Better Stack page exists) → CI green → merge → `images` publishes to GHCR.
2. Railway `staging` environment: datastores → ingest → web → marketing on Railway domains; smoke (T2) green.
3. **qa-team pass on staging (K0, user-required)** — PASS or user-recorded known-issues before step 4.
4. Railway `production` environment on the same images; DNS cut-over at Squarespace (critical item, user confirms); smoke on the custom domains; Better Stack monitors created (user) → T5 lands.
5. Polar promotion (critical item, D173.5/D177/D200/D104) → `OBSTACK_BILLING_MODE=polar`.
6. Receiver activations → real captures → T6 flips (critical item).
7. Design-partner activation (user) → exit.

## Ship log (manager only, append as executed)
<!-- step — command — result — confirmation ref (for gated steps) -->

## Goal check (Step 7, one entry per iteration)
- iteration 0: pending
- gap tasks this round: none
- at limit and still unmet: —

## Runbook (final)
- deployed: — | images — | urls `https://obstack.dev` `https://app.obstack.dev` `https://ingest.obstack.dev`
- verify: `npx tsx deploy/railway/smoke.ts` (T2)
- rollback: `railway redeploy` to the previous deployment per service (R7) — the previous sha tag is the rollback image
- secrets live in: Railway variables (per service); GHCR read PAT in Railway registry credentials; nothing in git

## Escalations log

## Retro (filled at end of run)
- shipped: —
- reviewer verdicts: — | secrets caught: —
- lesson: —

## Run log
- 2026-08-31 — intake (Step 1): M1–M12 measured; topology drafted; Railway facts R1–R14 from official docs (agent, 49 tool calls); Step 0 confirmed (defaults, limit 3) + user round (K0/T4/K5/K9). Advisor kickoff dispatched.
