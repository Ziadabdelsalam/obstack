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
- W2 shipped: master `964befe`, images published (see ship log)
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

## Advisor decisions (kickoff 2026-08-31 — full text + E1–E7 evidence: `.planning/2026-08-31-s5-advisor-kickoff.md`; BINDING)
- **D332** CI→GHCR, immutable `sha-<sha>` tags only; Railway pulls with a CLASSIC PAT `read:packages`; Railway Pro = T0 prerequisite; public images refused. Deploy = new sha ref + redeploy; rollback = previous sha.
- **D333** `images.yml`: `push: [master]` + `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` (stack.yml:96-112 pattern); new `publish` job, `packages: write` there only; four images; refusal re-run on the published mock.
- **D334** own pinned datastore images, one volume + one replica each, EU West for all five; backups feature verified at T0 (present → daily; absent → runbook says so, dump = M5).
- **D335** no config-as-code for image services; T2 = runbook table + `.env.example` + `smoke.ts` (unattended HTTPS probes, red-proven); compose smoke/e2e-drive NOT reused.
- **D336** launch HTTP-only unless staging proves gRPC on a second domain → :4317 (vendored grpc exporter); pass → `ingest-grpc.obstack.dev`; fail → GRPC endpoint unset. TCP proxy refused.
- **D337** ingest `PORT=8080` (healthcheck routing only), explicit target ports per domain, admin never public; web/marketing `PORT=3000` explicit, healthchecks `/login` and `/app`.
- **D338** billing mode `polar`; `BillingMode = "fake"|"polar-sandbox"|"polar"`; `createPolarBilling(mode)` picks `server`; `isPolar()` predicate; D110 intact; owns = E5 list.
- **D339** obstack-owned limiter `server/rate-limit.ts` wrapping the signup/login ACTIONS (better-auth's limiter never reaches in-process `auth.api.*` — E1): signup 5/IP/1h, login 10/IP/10min, first hop of `x-forwarded-for`, no-IP → allow + warn once; red-first test; `trustedOrigins` unset; no captcha; staging log grep for the no-IP warning = BLOCK.
- **D340** hosting negations flip now (D13 outranks landing-is-spec): mock `/signup`,`/login` → `next.config` redirects to the app origin when set; five sentences derive from new `appHost()` (set: "on <host>"; unset: "on an obstack you run yourself"); "We don't host obstack for anyone yet" DELETED; fence banned list grows; `mock-mode.test.ts:92,130` reconciled. "+ usage" verified at promotion (no metered price → "/mo"). "installed from this repo today" STAYS; SDK publish OUT. `robots.ts` IN (live `Disallow: /`, mock allow); OG/sitemap/manifest OUT.
- **D341** Explain: `fake.ts:63-64` suffix → "the operator of this deployment can configure one."; docs `explain/index.mdx` gains the hosted-fake sentence; fake runs still meter; no marketing fence row.
- **D342** `/status`: link only; `OBSTACK_STATUS_MONITOR_URL` build ARG/ENV beside `OBSTACK_APP_ORIGIN`; server-only helper refusing non-https; set/unset sentences ruled; monitor check set named.
- **D343** K0 charter: the D38(e) walk on staging + adversarial list; PASS before any DNS edit.
- **D344** production NEVER runs `fake`/`polar-sandbox`; production env carries the production rail before its first deploy; app cut-over gated on U14; promotion checklist (real checkout refunded, real webhook, D200 revocation once).
- **D345** Vercel flip on a real drain capture; CloudWatch needs AWS — none → stays SOON, recorded. Separate commits.
- **D346** rollback per service (dashboard or previous sha + redeploy); datastores never; across a migration boundary = escalation; verification = smoke + boot log lines.
- **D347** DNS: Squarespace ALIAS at apex (resolved); parked records copied into the ship log; TTL 300; order app → ingest → www+apex; rollback = restore parked records.
- **D348** security posture + inventory (kickoff file §2): classic PAT 90-day, no Railway token anywhere (browser login is the only deploy path), `BETTER_AUTH_URL=OBSTACK_APP_URL`, drain secret unset until a drain exists.
- **D350** (review A E-A1) ClickHouse `default` user restricted to loopback IN the shared `obstack-users.xml` (compose + the chart's pinned copy); `CLICKHOUSE_PASSWORD` refused; red-first probe from a second container. Owner T3. Blocks W2.
- **D351** (E-A2) the read-only `images` job builds the Railway ClickHouse image and runs the D350 probe on every PR. Owner T1. Blocks W2.
- **D352** (E-A3) `publish` boots the PUBLISHED live image (`CLICKHOUSE_URL=http://127.0.0.1:1`, throwaway secret) → `GET /login` 200 in 60 s + the live-without-secret refusal on the published tag. Owner T1. Blocks W2.
- **D353** (E-A4) boot-time refusal in `checkModeStampOnBoot`: mock stamp + `OBSTACK_BILLING_MODE` ≠ `fake` → exit 1 naming both; `images` job arm proves it red. Inverse (live + fake) refused — D344 stays a runbook rule verified live. Owner T4 (`mode-stamp.ts` + test) / T1 (arm). Blocks W2.
- **D354** (review C-1 E-C1) `web.yml` gains a second mock build with `OBSTACK_APP_ORIGIN=https://app.example.test` + the fence/app-href/mock-mode/robots tests; the hosted arm FAILS (never skips) when its env promises a hosted build; `images`-job variant refused (D107 stay-separate); the `/signup`,`/login` redirects gate on the mock stamp AND the origin, unit-tested. Owner T7 (F5). Blocks W2. New `web` band recorded in the exit bundle (D137 watch).
- **D355** (review C-2 E-C2) `::/0` + `GRANT ALL ON obstack.*` stand for M4 — single-tenant project, the credential is the boundary; passwords placed per service only; network-scoping refused (R3); grant narrowing = M5 item with its method fixed (`SHOW GRANTS` diff, red-proven by compose boot + `stack`). Owner T2 (runbook). Blocks nothing.
- **D356** (E-W3, user: Hobby + GitHub connect) K1(b): web/marketing/ingest/clickhouse = GitHub-connected services building from the repo (roots `/`,`/`,`services/ingest`,`/`; `RAILWAY_DOCKERFILE_PATH` for web/marketing/clickhouse); Postgres stays `postgres:17.11` (public image, any plan); GHCR pull path + PAT deleted from the plan; same-images = same source/commit/build config (D251(d) letter), each deployment recorded as (sha, Dockerfile, root, ARG values from the build log, stamp boot line), proven by smoke + K0; build ARGs = service variables of the same three names — first staging build measures it (miss = escalation); `publish` STAYS as the artifact record + refusal proofs; GitHub App installed for the `obstack` repo only. Owner T2. Blocks W3.
- **D357** staging tracks `master` (auto-deploy, Wait-for-CI ON — T0 verifies the toggle; absent → manual redeploys after green); production tracks branch `production`, operator fast-forwards to the K0-passed commit, every push = critical item; config-as-code valid again → `deploy/railway/{web,marketing,ingest,clickhouse}/railway.json` (dockerfilePath, healthcheck, restartPolicy, numReplicas 1, region, watchPatterns per tree); rollback = dashboard Rollback + `production` reset to that commit; Hobby T0 checks: attach `app.obstack.dev` to production web now (refused → Pro mandatory for the cut-over, blocks W4 not W3); 5 GB volume cap = runbook watch. Owners T0 + T2. Blocks W3 via T2.
- **D358** (E-W3 volumes; workspace is on the free TRIAL — user: stay on it for staging) Trial 500 MB → W3 proceeds (every staging proof stays meaningful), **W4 blocked on the $5 Hobby subscription; production volumes never created on the trial.** Hobby 5 GB fits five free partners; Pro (50 GB) mandatory when measured bytes/row × projected resident rows > 2.5 GB or the volume passes 60 % — a user decision with the number, critical item. Measurement after K0 + 24 h on staging: `system.parts` bytes/row per table (owner T2, runbook §capacity); watch `railway volume list` weekly, alarm 60 %, act 75 %; Postgres ≈120 MB idle, >200 MB after 24 h = anomaly. **F-T3b** (T3, next PR, non-blocking): `config.d` drops ClickHouse's `metric_log`/`asynchronous_metric_log`/`trace_log`/`part_log`/`query_thread_log`/`text_log`, `query_log` TTL 7 d.
- **D349** M-fact corrections: M10 (CLI installed), M9 (`:157` is a comment; auth pages carry the copy), M3 (K3 premise wrong), T4/T2/T5/T8 owns re-based.

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
- status: approved (W1, reviewed; committed on s5-ship)
- owns: `.github/workflows/images.yml` (+ `deploy/README.md` registry paragraph if one exists)
- playbook: GitHub repo & CI; Docker + registry
- done-check: `actionlint` clean; the push step is gated `github.ref == 'refs/heads/master'`; tags `sha-<sha>` + `master`; `permissions: packages: write` on that job only; the mock variant is built TWICE or parameterised — the published `mock` tag carries `OBSTACK_APP_ORIGIN=https://app.obstack.dev` (M7) and the refusal matrix still runs on the unset build; D41 backstop (`cancel-in-progress` never on master) untouched.
- result:

### T2: Railway config-as-code + runbook — `deploy/railway/`
- status: approved (W1, reviewed; committed on s5-ship)
- owns: `deploy/railway/README.md`, `deploy/railway/.env.example` (names only), `deploy/railway/smoke.ts` (D335; `railway.json` VOID per E3)
- playbook: Fly.io / Railway / plain VPS; Docker + registry
- done-check: every name in §Topology appears once in the env example with its source; `railway.json` validates against the schema URL; smoke script runs against a URL triple (`MARKETING_URL`, `APP_URL`, `INGEST_URL`) and exits non-zero on any failed probe — proven red against a wrong URL.
- result:

### T3: ClickHouse image for Railway — `deploy/railway/clickhouse/Dockerfile`
- status: approved (W1, reviewed; committed on s5-ship)
- owns: `deploy/railway/clickhouse/Dockerfile` (+ `.dockerignore`), reusing `deploy/compose/clickhouse/users.d/obstack-users.xml` by `COPY` (single source — no second copy of the XML)
- playbook: Docker + registry
- done-check: `docker build` from the repo root; `docker run` with the two passwords → `SELECT 1` succeeds as `obstack_ingest` and `obstack_web`, `obstack_web` cannot `CREATE` (the read-only grant holds); image published by T1 as `obstack-clickhouse:<sha>`.
- result:

### T4: production billing mode (M1, D173.5) — executor Opus 5 (user-approved one-task exception)
- status: approved (W1, reviewed; committed on s5-ship)
- owns (E5, measured): `apps/web/src/server/billing/{client,polar,types,reporter,fake}.ts`, `billing.test.ts`, `reporter.test.ts`, `deploy/compose/e2e-drive.mjs:149` (comment)
- playbook: —
- done-check: `OBSTACK_BILLING_MODE=polar` selects `server: "production"` on the same module; sandbox arm unchanged; tests cover both; `grep -rn 'polar-sandbox'` finds only the sandbox arm and its docs; typecheck + `apps/web` tests green; D110 boundary intact (still the ONLY module that calls Polar).
- result:

### T5: `/status` monitor wiring (U12 = Better Stack, D256, M4)
- status: approved (W1, reviewed; committed on s5-ship)
- owns: `apps/web/src/app/status/page.tsx`, `status.test.ts`, the `/status` docs sentence if any
- done-check: the monitoring section renders the monitor's real public artefact (link/badge) and the pinned sentence is replaced by a sentence the test derives from the monitor URL env (`OBSTACK_STATUS_MONITOR_URL`, unset = the current sentence, so compose/chart keep the truth); fence 8/8 still green.
- result:

### T6: SOON-card flips (D101/D285/D208)
- status: pending (BLOCKED on the two real captures — post-deploy)
- owns: `apps/web/src/components/connections/connectors.ts` (Vercel `:151-153`, CloudWatch `:160-162`), the D208 tests, the connectors docs page
- done-check: each flip commit cites the capture (delivery id, timestamp, `ingest.obstack.dev` log line) and the fixture re-validation; flips are separate commits so one can land without the other.
- result:

### T7: launch copy under hosting (K6 ruling) + OG/robots/sitemap/manifest
- status: approved (W1, reviewed; committed on s5-ship)
- owns: `apps/web/src/app/page.tsx` (`:157,:162,:395,:446,:550`), `apps/web/src/app/invite/[id]/page.tsx:172`, `apps/web/src/app/{robots,sitemap,manifest}.ts`, `opengraph-image`, the S4.4 landing fence rows they touch (`.planning/2026-08-30-s4.4-landing-fence.md`)
- done-check: fence tests updated in the same commit; rendered-bytes sweep green in both modes; `curl https://obstack.dev/robots.txt` after deploy.
- result:

### T8: signup abuse controls (K3 ruling)
- status: approved (W1, reviewed; committed on s5-ship)
- owns (D339): new `apps/web/src/server/rate-limit.ts` + test, `apps/web/src/server/auth.ts` (signup action seam), `apps/web/src/app/login/actions.ts`
- done-check: the limiter's storage and window are named in `deploy/railway/README.md`; `trustedOrigins` carries exactly the two hosts.
- result:

### T9: Explain honest absence on the hosted app (K5)
- status: approved (W1, reviewed; committed on s5-ship)
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
- 2026-08-31 — **W3 step 8: full staging smoke 12 ok / 0 FAIL / 2 skipped** (marketing 4, app 4, ingest 4 — `POST /v1/traces` unauth → 401 + `WWW-Authenticate: Bearer`, admin 404s on the public port; the two skips need an issued API key = the K0 walk's first act). Ingest public domain `https://ingest-staging-4dfd.up.railway.app` → target port 4318 (explicit, D337). Marketing's junk keys deleted. Staging is FIVE-FOR-FIVE GREEN. Next: the :4317 gRPC domain (D336 proof), then the K0 qa-team gate — its billing arm needs the user's Polar sandbox values on the web service.
- 2026-08-31 — **W3 step 7 — second incident + full repair.** Ingest kept failing auth after the root-dir fix; measurement showed `railway variable -s` is silently IGNORED (reads/writes hit the LINKED service) — so the earlier "rotation" had landed on ingest: ClickHouse and Postgres were still running the EXPOSED passwords, web's datastore creds and ingest's DSNs pointed at values the stores never had, and web's URL vars sat on marketing. **Repair (link-first pattern):** fresh secrets on clickhouse (both) and postgres (new empty volume `postgres-volume-FPDv`, clean initdb), ingest DSNs + web creds/URLs re-set on the RIGHT services, junk keys removed from ingest (two left on marketing, harmless — delete needs interactive confirm). Redeploy chain green: clickhouse SUCCESS → postgres SUCCESS → **ingest SUCCESS: migrations applied, OTLP gRPC `[::]:4317` + HTTP `[::]:4318` listening, admin `:8080`, drain verification `enabled=false` logged honestly.** Runbook gains the CLI service-targeting caution. All previously exposed credentials are now dead.
- 2026-08-31 — **W3 step 6: web + marketing staging builds SUCCESS; smoke 8 ok / 0 FAIL / 6 skipped (ingest pending its root dir).** D356 first-build measurement satisfied by the artifacts: marketing renders six CTAs on the baked `https://web-staging-c9d9.up.railway.app` origin and 307s `/signup` there (the build ARGs reached `next build` — service variables ARE exposed as ARGs); web serves `/login` live with no boot refusal; `POST /api/billing/webhook` unsigned → 403 (4xx, never 5xx); `POST /api/auth/sign-up/email` → 404. Remaining W3: ingest root dir (user) → ingest smoke arms + the D336 gRPC proof → K0 qa-team gate.
- 2026-08-31 — **W3 step 5: Hobby subscribed (user) → `web` + `marketing` created** (repo builds, `RAILWAY_DOCKERFILE_PATH=apps/web/Dockerfile`; web: live mode, DSNs as literals per the reference caution, fresh staging `BETTER_AUTH_SECRET`, `OBSTACK_BILLING_MODE=fake` until the sandbox values land for K0; marketing: mock). Staging domains issued: web `https://web-staging-c9d9.up.railway.app`, marketing `https://marketing-staging-e16c.up.railway.app`; `BETTER_AUTH_URL`/`OBSTACK_APP_URL` set on web, `OBSTACK_APP_ORIGIN` on marketing (bakes at its build — the D340 redirect + CTA measurement rides this build). Volume caps still print 500 MB post-subscription — watch; grow via dashboard if unchanged.
- 2026-08-31 — **W3 step 4 — incident + rotation.** Inspecting the stray service printed RESOLVED variable values into the session log (the CLI's `variable list` renders secrets; the `${{…}}` references set via `--variables` were stored RESOLVED — measured, runbook caution added). Exposed: the ClickHouse ingest password + the Postgres password (both guarding empty staging stores, minutes old). **Rotated:** both ClickHouse passwords (users.d reads env at boot), Postgres via a new password + fresh empty volume (initdb re-ran; orphan volume deleted); ingest DSNs re-set from the new values in-shell (unprinted). Stray duplicate-ingest `valiant-vitality` deleted. States: postgres SUCCESS (rotated), clickhouse first repo build in progress (D356 measurement pending), **ingest FAILED as the runbook predicted** (no root directory → Railpack tried the monorepo as Node; fix = dashboard Root Directory `services/ingest`). **W3 blockers: the $5 Hobby subscription (web/marketing provision-refused) + dashboard steps (ingest root dir, 4× config-as-code path, Wait-for-CI, region check).**
- 2026-08-31 — **W3 step 3: PR #26 all ten green → MERGED (`9155535`).** Staging services from the repo: `clickhouse` (repo build, `RAILWAY_DOCKERFILE_PATH=deploy/railway/clickhouse/Dockerfile`, two generated passwords, volume attached at `/var/lib/clickhouse`) and `ingest` (repo build, DSNs via `${{postgres.POSTGRES_PASSWORD}}` / `${{clickhouse.…}}` references, `PORT=8080`) created; **`web` and `marketing` REFUSED — "Free plan resource provision limit exceeded"** (the trial caps provisioned services; postgres+clickhouse+ingest hit it). **W3 is now blocked on the $5 Hobby subscription** (D358's W4 gate arrives early). One stray service (`valiant-vitality`) from the failed adds — inspected, deleted if empty. Ingest's root directory (`services/ingest`) + the four config-as-code paths + Wait-for-CI remain dashboard steps (user or post-subscription).
- 2026-08-31 — **W3 step 2:** F6/F7 (T2) + F-T3b (T3) → **review W3-a** (Opus) FIXED (6: the domains→target-ports table had been dropped — with ingest `PORT=8080` the public host would have routed to admin; trial stated as measured with 60/75 % of the printed cap; `deploy.region` acknowledged but dashboard-set; `dockerfilePath` resolution = Unknown 9, measured on the first ingest build; `watchPatterns` gained each service's own `railway.json` and `services/ingest/pricing/prices.json` for web/marketing) · F-T3b APPROVE (context 435 B; six tables absent; TTL present; D350 holds). Watch item recorded: `system.error_log`/`query_metric_log` untailed, outside D358. Committed on `s5-w3`; PR → CI → merge before services are added (Railway reads `railway.json` from master).
- 2026-08-31 — **W3 step 1: staging `postgres` live** — `postgres:17.11` (public image, D356), region `ams` (EU West), variables `POSTGRES_USER=obstack` `POSTGRES_DB=obstack` `PGDATA=/var/lib/postgresql/data/pgdata` + a generated `POSTGRES_PASSWORD` (created in-shell, never printed), volume `postgres-volume` at `/var/lib/postgresql/data` (the CLI's `volume add` ignored `-m` and left it unattached at `/tmp` on first try — fixed via `volume update -m` + `attach`; the CLI panics on `volume add` without an explicit service ID), deployment `cb536fa8` SUCCESS. **Measured: Hobby volume cap is 500 MB** (`0MB/500MB`), not the 5 GB D357 assumed → escalated.
- 2026-08-31 — **W3 step 0 (user-confirmed): Railway project `obstack` created** in the `hi@obstack.dev` workspace (id `5b87dbab-aa3f-4697-af6d-1a49c7ea49bc`), environments `production` (default) + `staging` (CLI linked to staging for W3). **User directive: stay on Hobby; connect GitHub to Railway instead of a PAT** → private GHCR pulls unavailable (R5) → K1(b) repo builds → advisor re-ruling requested (E-W3 → D356). The GitHub-app authorisation is the user's browser step before any service can be added from the repo.
- 2026-08-31 — **W2 CLOSED: PR #25 MERGED → master `964befe`** (user gate: "Merge now"). Master `images` run 33401515704: `images` 4m46s green, **`publish` 5m22s green — the first GHCR push**: `ghcr.io/ziadabdelsalam/obstack-web:live-sha-964befec8f55dd9759e4542f3b8725c854f969f6`, `…/obstack-web:mock-sha-964befe…` (baked `OBSTACK_APP_ORIGIN=https://app.obstack.dev`, monitor URL UNSET — the repo variable did not exist yet; T5 republish pending U12), `…/obstack-ingest:sha-964befe…`, `…/obstack-clickhouse:sha-964befe…`; the published mock refused live and polar, the published live booted to `/login` 200 and refused without a secret (D352/D353 on the published digests). Digests are in the run's step summary (not API-readable; read back at the first Railway pull / `docker manifest inspect` with the PAT). Master `stack` green. **U12 progress:** the user chose `https://status.obstack.dev` as the monitor URL (custom domain on Better Stack; not resolving yet) — the variable is set when it answers.
- 2026-08-31 — **PR #25 run on `2d5dc3d`: all ten green.** Bands: `web` **5m03s** (new band with the second mock+origin build + hosted fence — D354's D137 watch; ~4 min before), `images` **4m46s** (+ ClickHouse build, D350 probe, D353 arm; `publish` skipped on the PR path), `stack` 8m55s, `e2e` 5m52s, `sdk-e2e` 3m55s, `go` 2m31s, `kind` 1m38s, `sdk-js` 1m00s, `lint` 0m35s, `sdk-py` 0m31s. Merge gate → user (triggers `publish`, the first GHCR push).
- 2026-08-31 — **advisor sign-off on critical items 1–4** (tip `7748f9a`): T1 SIGNED WITH CONDITIONS (T0: `vars.OBSTACK_STATUS_MONITOR_URL` repo variable before merge, else T5 republishes later; user confirms the first GHCR push), T4 SIGNED, T7 SIGNED (record the `web` band), **T8 SIGNED WITH ONE CONDITION — F-T8a: key on the RIGHTMOST `x-forwarded-for` hop** (leftmost is client-forgeable) → applied by the manager (`clientIpFromForwarded`, test flipped, runbook §6 rewritten). Merge may proceed once CI is green on the new tip.
- 2026-08-31 — W2 step 1: branch `s5-ship` pushed (`7748f9a`, 18 commits); **PR #25 opened** (https://github.com/Ziadabdelsalam/obstack/pull/25); CI run 1 watching; advisor sign-off on critical items 1–4 requested. Merge = user's call after CI green + sign-off; merge triggers `publish` (first GHCR push — critical item 1b, user confirms).

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
- 2026-08-31 — **F5** (T7, D354) done in the worktree → cherry-picked `94e149b`; **review F5** (Opus) APPROVE (red re-proven 34/1 → 35/0; manifests 4/0/0; `web` job has headroom in its 15-min timeout — new band to be recorded from the PR run). **Integrated check on the tip** (manager, main checkout): tsc, actionlint ×2, helm lint 0 failed, Go tests ok, mock+origin build, web suite **550/497/0 fail/53 skip**. **W1 CLOSED: 9 tasks + F1–F5, verdicts A: fixed/fixed/approve/approve · B: fixed/approve/approve · C-1: fixed · C-2: approve/fixed/must-fix(1 line)→fixed · F5: approve.** → W2: PR.
- 2026-08-31 — **review C-2** (Opus): F2 APPROVE (`default` refused over the network even with `CLICKHOUSE_PASSWORD` set; no consumer breaks), F3 FIXED (7: the D350 probe as written did not test D350 — now runs with a correct `default` password so only the network can refuse, red-proven on a stripped image; ingest arm re-based to `obstack.*` DDL; web arm `CREATE TABLE` → ACCESS_DENIED; `Code: 516` grep; one `trap EXIT` teardown; stopgap comments → invariants), F4 APPROVE after a one-line comment fix — committed `d6b48fa` `2810f3c` `2868747` `61ccd67`. Escalation E-C2 → **D355** (posture stands; runbook paragraph added by the manager). F5 (T7, D354) running.
- 2026-08-31 — **review B** (Opus): T2 FIXED (7: restart ALWAYS not ON_FAILURE, fabricated "documented default" removed, replica reasons corrected, x-forwarded-for spoofing consequence + K0 forged-header proof, `PORT` in env example, TLS probe refuses http), T5 APPROVE, T8+F1 APPROVE (red-first re-proven 5/8) — committed `00d7347` `5d62d2b` `eef0e12`; full web suite 539/486/53 skip/0 fail. **Review C-1** (Opus, worktree): T7 FIXED (the rendered sweep had claim 13 disarmed on landing/auth in every build — hosted-arm guard added, red-proven; live-build fence failures pre-existing at `f7b9dd0`, unreachable in CI) — cherry-picked `0ea904d`; escalation → **D354** → F5 (T7). F2 (T3) done with a measurement correction: the upstream entrypoint already loopback-restricts `default` unless `CLICKHOUSE_PASSWORD` is set — the XML rule makes it unconditional; `obstack_ingest` cannot `CREATE DATABASE` outside `obstack` (grant `ALL ON obstack.*`) → F3's CI probe arm re-based in review C-2. F3 (T1) done (6 new steps); F4 (T4) done (mode-stamp refusal, 13/13). Review C-2 (F2 F3 F4) running.
- 2026-08-31 — **review A** (Opus): T1 FIXED (token/vars via env), T3 FIXED (`Dockerfile.dockerignore`), T4 APPROVE, T9 APPROVE — committed `5b4a4d0` `ed9ca41` `ea7658b` `85a066e`; four escalations → **D350–D353** (all block W2) → F2 (T3) ∥ F3 (T1) ∥ F4 (T4). T8 scope gap → F1 (refusal copy) done. Manager fixed the docs carrier of the dead `/status` sentence + the mirror-test list. `.gitignore` negation for `deploy/railway/.env.example`.
- 2026-08-31 — **kickoff (Step 2): D332–D349 recorded**, task list re-based (T2 railway.json void, T4/T8 owns measured, T5 build-ARG shape); branch `s5-ship` cut from `f5a0781`; **W1 dispatched: T1 T2 T3 T4(Opus) T5 T7(worktree) T8 T9** in parallel.
- 2026-08-31 — intake (Step 1): M1–M12 measured; topology drafted; Railway facts R1–R14 from official docs (agent, 49 tool calls); Step 0 confirmed (defaults, limit 3) + user round (K0/T4/K5/K9). Advisor kickoff dispatched.
