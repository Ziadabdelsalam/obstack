# S5 kickoff — advisor rulings D332–D349 (2026-08-31, master `f7b9dd0`; planning tip carries no code)

Advisor: Fable 5 (ziarmy deploy-team, single advisor, xhigh). Plan: `.planning/2026-08-31-s5-deploy-plan.md`. Overflow evidence E1–E7 at the end of this file.

## Measured-fact corrections (rulings resting on these are re-based, none void)
- **M10 false in part:** Railway CLI IS installed (`railway 5.45.10`), unauthenticated at measurement (logged in as `hi@obstack.dev` since). T0's check = login, not install.
- **M9 imprecise:** `page.tsx:157` is a JSX comment; rendered hosting-denial copy = `page.tsx:162,550`, `signup/page.tsx:52-53`, `login/page.tsx:47-49`, `invite/[id]/page.tsx:172` (M9 omits the auth pages D329 names). "+ usage" and "installed from this repo today" each carry in ONE file (`page.tsx:446`, `:395`).
- **M3 incomplete → K3's premise is wrong:** signup/login are in-process `auth.api.*` calls (`auth.ts:134`, `login/actions.ts:34`); better-auth's limiter runs only in the HTTP router's `onRequest` (`dist/api/index.mjs:168`); the mounted handler allowlists `get-session`/`sign-out` only. A `rateLimit` config would be a no-mechanism ruling (E1).
- **T4 owns overstated:** no `deploy/**` or docs file names `polar-sandbox` (E5). **T2's `railway.json` void** (E3). **T5's runtime-env shape void:** `/status` is SSG (E2). **R6 paraphrase overstated** (ARGs are not automatic) — moot under D332. M1/M2/M4–M8/M11 verified exact.

## 1. Pipeline shape
- **D332 (K1):** CI → GHCR, immutable `sha-<sha>` tags ONLY (no `master`/`latest`); Railway pulls with a **classic** PAT `read:packages` (fine-grained PATs cannot read GHCR — plan's "fine-grained" is wrong); **Railway Pro is a T0 prerequisite** (R5); public images REFUSED (private repo's server code). Deploy = set the service's image ref to the new sha + redeploy; rollback = previous sha. — The digest Railway runs is the digest CI built and refusal-tested.
- **D333 (T1 shape):** `images.yml` gains `push: branches: [master]` and `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` (copy `stack.yml:96-112`; the plan's "D41 untouched" is wrong — push + `true` opens the D306(b) hole). New job `publish`: `needs: images`, `if: github.event_name == 'push'`, `permissions: {contents: read, packages: write}` on that job only; builds web-live (`OBSTACK_STATUS_MONITOR_URL`), web-mock (`OBSTACK_APP_ORIGIN=https://app.obstack.dev` + monitor URL), ingest, clickhouse (T3); re-runs the mode-mismatch refusal on the PUBLISHED mock image; digests to the job summary. — One job holds write; PR runs stay read-only.
- **D334 (K7):** own pinned images, one volume + one replica each (R4), all five services in **EU West** (one region; datastore moves cost a migration). Postgres `postgres:17.11`, `PGDATA=/var/lib/postgresql/data/pgdata`, mount `/var/lib/postgresql/data`, no HTTP healthcheck. ClickHouse = T3 image, mount `/var/lib/clickhouse`, `PORT=8123`, healthcheck `/ping`. Backups: T0 verifies the volume Backups feature exists in the dashboard (not in R-facts) → present: daily on both volumes before production data; absent: runbook states "no backups — a volume loss loses partner data", dump procedure is an M5 item, not built here.
- **D335 (K8/T2):** config-as-code refused for image-sourced services (undocumented, M12 rule). T2 = `deploy/railway/README.md` runbook with the per-service settings table (image ref, `PORT`, healthcheckPath/timeout 120 s, restart policy, replicas 1, region, mount, domains→target ports, variable names + sources, the D339 limiter paragraph, PAT expiry date) + `.env.example` (names only) + `deploy/railway/smoke.ts`. **Smoke = unattended HTTPS probes** on a URL triple: TLS valid; marketing `/app` 200, `/docs/quickstart` 200, `/signup`→30x to the app origin; app `/login` 200 with the form, `/api/auth/sign-up/email` 404, `/api/billing/webhook` POST unsigned → 4xx not 5xx; ingest `POST /v1/traces` no bearer → 401 + `WWW-Authenticate: Bearer`, with `OBSTACK_SMOKE_API_KEY` (optional, operator-issued) → 2xx, `GET /healthz` and `/metrics` → 404; optional `INGEST_GRPC_URL` leg (D336). Proven red on a wrong URL. `deploy/compose/smoke.ts`/`trace-checks.ts` NOT reused — they need ClickHouse, which is private; `e2e-drive.mjs` is compose-bound (local CDP ports, direct PG/CH). Trace-with-cost arrival is the K0 charter (D343).
- **D336 (K4):** launch **HTTP-only** unless staging proves gRPC: second staging domain → target port 4317; smoke exports one span via vendored `@opentelemetry/exporter-trace-otlp-grpc` over TLS; arrival confirmed by the K0 walker in the UI. Pass → production `ingest-grpc.obstack.dev`→4317 and `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT` set; fail → unset (ConnectModal absence, `ConnectModal.tsx:34`), failure recorded. TCP proxy refused (no custom domain, no TLS story).
- **D337 (exposure):** ingest `PORT=8080` (healthcheck routing only — Go ignores `PORT`), every domain sets an explicit target port; admin never public, proven by the 404 probes above. Web/marketing `PORT=3000` explicit (Next standalone honours `PORT`; Railway's injected value would move the listener), healthchecks `/login` and `/app`.
- **D338 (K2):** mode name **`polar`**; `BillingMode = "fake" | "polar-sandbox" | "polar"`; `createPolarBilling(mode)` selects `server: "production"` vs `"sandbox"`, returns the configured `mode`; one `isPolar()` predicate replaces `!== "polar-sandbox"` (`reporter.ts:156`); error strings name the configured mode. D110 intact. Owns = E5's measured list; tests mirror both arms (D194: the sandbox evidence stays green).
- **D339 (K3):** obstack-owned limiter `apps/web/src/server/rate-limit.ts` wrapping the signup and login actions: in-memory sliding window keyed `(ip, action)`; signup **5 / IP / 1 h**, login **10 / IP / 10 min**; IP = first hop of `x-forwarded-for`; no IP → allow + warn once (fail-open, loud). One replica → memory is correct; README names the multi-replica consequence. Red-first test: 6th signup from one IP refused, 6th from another allowed. **`trustedOrigins` unset** (default = `BETTER_AUTH_URL` origin; the marketing host never calls auth) — T8's "exactly the two hosts" VOID. No captcha. **Staging proof:** the K0 gate greps web logs for the no-IP warning = BLOCK (Railway's forwarded header is not quoted in R-facts).
- **D340 (K6):** the hosting negations become false the moment `app.obstack.dev` exists — D13 outranks landing-is-spec (it freezes target claims, never keeps a false one). (a) mock image `/signup`,`/login` → `next.config` `redirects()` to the app origin when `OBSTACK_APP_ORIGIN` is set (vendored Next docs read first); (b) the five rendered sentences derive from a new `appHost()` in `lib/app-href.ts` — set: "on <host>" rendered from env (U11: never a literal); unset: "on an obstack you run yourself"; the "We don't host obstack for anyone yet" clause is DELETED; (c) fence banned list gains "host obstack for anyone" + "an obstack you run"; `mock-mode.test.ts:92,130` reconciled. "+ usage": verified against the production Pro product at promotion; no metered price → "/mo" in the promotion commit (a price is a contract term). "installed from this repo today" STAYS; **SDK publish OUT**. **`robots.ts` IN** (live image `Disallow: /`, mock allow-all; one file + test); **OG image / sitemap / manifest OUT** (M5 polish).
- **D341 (K5/T9):** site = the fake's own suggestion line (`fake.ts:63-64`, rendered as SUGGESTED FIX, `ExplainPanel.tsx:293`): keep the pinned prefix "This deployment runs Explain in fake mode (OBSTACK_EXPLAIN_MODE=fake)"; replace "Configure a model to get a real reading." with "the operator of this deployment can configure one." (true hosted and self-hosted). Docs `explain/index.mdx` gains "The hosted obstack runs Explain in fake mode today; no model is behind it." D168 consequence: fake runs still meter (no mode-dependent quota path). No marketing fence row (landing-is-spec).
- **D342 (K9/T5):** **link only** — no third-party script or image on `/status`. `OBSTACK_STATUS_MONITOR_URL` is a build ARG/ENV beside `OBSTACK_APP_ORIGIN` (`Dockerfile:52-53`), server-only helper, refuses non-https. Set → "External uptime monitoring for obstack is published at <link>"; unset → "This deployment publishes no external uptime monitor." (the "begins at launch" sentence is time-bound → dies). T5 needs only the Better Stack status-page URL (T0), not monitors. Check set: `obstack.dev/app`, `app.obstack.dev/login`, `ingest.obstack.dev` on the public port with the status measured on staging (`GET /v1/traces` → 405), never an assumed 200.

## 2. Security posture
- **D348:** GHCR PAT = classic, `read:packages` only, 90-day expiry, lives only in Railway registry credentials, expiry in runbook. `GITHUB_TOKEN` `packages: write` on `publish` only. **No Railway token anywhere**: `railway login` (browser) is the only deploy path; CI never deploys. `BETTER_AUTH_URL=OBSTACK_APP_URL=https://app.obstack.dev` (staging: the Railway domain). `OBSTACK_VERCEL_DRAIN_SECRET` unset until a drain exists (bearer still required, `vercel.go:40-48`). Never in git/logs: every value below, `.env.local`, Squarespace/Railway/Polar/Better Stack logins, API keys issued during QA, webhook payload bodies with secrets, the PAT.

| name | source | store |
|---|---|---|
| `BETTER_AUTH_SECRET` (prod + staging, distinct) | `openssl rand -base64 32` (user) | Railway vars: web |
| `POSTGRES_PASSWORD` → both DSNs | generated (user) | Railway vars: postgres, web, ingest |
| `OBSTACK_CLICKHOUSE_INGEST_PASSWORD` / `_WEB_PASSWORD` | generated (user) | Railway vars: clickhouse, ingest / clickhouse, web |
| `POLAR_ACCESS_TOKEN` (prod `polar_oat_`; staging sandbox) | Polar (user, U14) | Railway vars: web |
| `POLAR_WEBHOOK_SECRET` (prod/staging endpoints) | Polar webhook endpoint | Railway vars: web |
| `POLAR_PRODUCT_PRO` (env-bound id, not secret) | Polar catalog | Railway vars: web |
| `OBSTACK_VERCEL_DRAIN_SECRET` (only with a drain) | Vercel | Railway vars: ingest |
| `OBSTACK_SMOKE_API_KEY` (staging, revoked after) | issued in the UI | operator shell only |
| GHCR classic PAT `read:packages` | GitHub (user) | Railway registry credentials |
| `GITHUB_TOKEN` `packages: write` | GitHub | `publish` job `permissions:` |
| Squarespace/Cloudflare DNS login | user | — |
| NOT created: `RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`, `ANTHROPIC_API_KEY` (K5 fake) | | |

## 3. Rollout, rollback, DNS, gates
- **D343 (K0 charter):** qa-team on Railway staging: the D38(e) walk (signup → key → OTLP POST HTTP [+gRPC per D336] → trace with ingest-computed cost in the UI) + adversarial: D339 limiter, cross-tenant invite, key revoke → 401, `/api/auth/*` 404s, admin 404, marketing `/signup` redirect, `__Secure-` cookie, sandbox checkout return path + a webhook delivery to the staging URL, web logs free of the no-IP warning. PASS or user-recorded known issues before any DNS edit.
- **D344 (Polar):** production NEVER runs `fake` or `polar-sandbox` (a free self-service Pro + a fictional checkout, E7). The production env is configured with the production rail BEFORE its first deploy; **the app cut-over is gated on U14.** Checklist after `app.obstack.dev` resolves: org verified; production token; production product id (+ "+ usage" check); webhook endpoint `https://app.obstack.dev/api/billing/webhook` registered → secret set; one real checkout (user's card, refunded in Polar); one real webhook delivery seen in web logs (event id); D200 revocation exercised once (cancel in Polar → plan row reverts; before/after rows in the ship log). Partners invited only after.
- **D345 (receivers):** Vercel flip needs a real drain on a user Vercel project + delivery id in ingest logs + fixture re-validation; CloudWatch needs an AWS account + the forwarder Lambda — **no AWS → CloudWatch stays SOON, recorded; exit clause unaffected.** Separate commits; T6 re-points `mock/connectors.test.ts:116` when Vercel flips.
- **D346 (rollback):** per service: dashboard Rollback (restores image + variables) or previous sha ref + redeploy; datastores never rolled back; migrations are forward-only → an ingest/web rollback across a migration boundary is an ESCALATION to the advisor, one sha at a time otherwise. Verification per deploy = the T2 smoke against that environment + `railway logs` boot lines (ingest migration summary, web mode stamp) — never exit codes.
- **D347 (DNS):** T0 checks Squarespace apex ALIAS/flattening (RESOLVED: ALIAS at `@` supported — `.planning/2026-08-31-s5-squarespace-dns-facts.md`); absent → Cloudflare DNS-only. Parked records copied verbatim into the ship log (= rollback). TTL 300 s. Order: (1) `app` → cert → smoke → D344 checklist; (2) `ingest` (+`ingest-grpc`) → smoke; (3) `www` + apex LAST. Rollback = restore parked records.
- **D349:** M-fact corrections as listed above; T0/T2/T4/T5/T8 re-based accordingly.

## Corrected task list (ID → owns → done-check → wave)
- **T0** operator prereqs → — → Railway **Pro**, project + `staging`/`production` envs, `railway whoami` OK, classic PAT, Squarespace apex verdict, Better Stack status-page URL 200, Polar org status, Vercel/AWS availability, backups feature present/absent → **W0**
- **T1** publish job → `.github/workflows/images.yml` → D333; `actionlint` clean; refusal on the published mock image → **W1**
- **T2** runbook + smoke → `deploy/railway/{README.md,.env.example,smoke.ts}` → D335 probes, red-proven → **W1**
- **T3** ClickHouse image → `deploy/railway/clickhouse/Dockerfile` (+`.dockerignore`), `COPY` of `deploy/compose/clickhouse/users.d/obstack-users.xml` → two users, `obstack_web` cannot `CREATE`; nofile limit observed on staging → **W1**
- **T4** (Opus) `polar` mode → `billing/{client,polar,types,reporter,fake}.ts`, `billing.test.ts`, `reporter.test.ts`, `e2e-drive.mjs:149` comment → D338; `grep polar-sandbox` = sandbox arm only → **W1**
- **T5** status link → `status/page.tsx`, `status.test.ts`, `apps/web/Dockerfile:52-53` region, new `lib/status-monitor.ts` → D342, fence 8/8 → **W1** (after T0's URL)
- **T7** hosting copy + robots → `app/page.tsx:162,550`, `signup/page.tsx:52-53`, `login/page.tsx:47-49`, `invite/[id]/page.tsx:172`, `signup/mock-mode.test.ts`, `lib/app-href.ts`+test, `next.config.ts`, `landing-fence.test.ts`, `app/robots.ts`+test, fence md rows → D340, rendered-bytes sweep both modes → **W1**
- **T8** limiter → new `server/rate-limit.ts`+test, `server/auth.ts` (signup action seam), `login/actions.ts` → D339 → **W1**
- **T9** Explain sentence → `server/explain/fake.ts:63-64`, `explain.test.ts`, `content/docs/explain/index.mdx` → D341; `e2e-drive.mjs:2159` prefix still matches → **W1**
- **W2** PR `s5-ship` → CI → merge → `publish` (GHCR first push = critical). **W3** staging: datastores → ingest → web → marketing, smoke, D336 gRPC proof, **K0 qa-team**. **W4** production env (rail configured per D344) → DNS per D347 → smoke → D344 checklist → Better Stack monitors. **W5** T6 flips on captures (`connectors.ts:151-162` + E5's 14 carriers) → partners.

## U-prerequisites (verify-or-block)
U12 → blocks T5 (ship without it: images carry the unset sentence, T5 lands in a follow-up PR + republish). U13 → blocks the exit clause only. **U14 → blocks the `app` DNS cut-over (D344).** U15 → launch without email, D339 is the abuse control, recorded. U16 → irrelevant under U10, recorded. Plus: Railway Pro, Squarespace apex, backups feature (D334), Vercel/AWS (D345).

## CRITICAL ITEMS (return to the advisor before execution)
1. T1 diff (push trigger + concurrency expression + `publish` permissions) and the first GHCR push. 2. T4 diff (D110 boundary). 3. T8 diff + its red-first proof. 4. T7's fence/banned-list changes. 5. Staging smoke + the D336 gRPC verdict. 6. qa-team staging verdict. 7. **Every first production deploy and the DNS cut-over** (user confirms each). 8. **Polar promotion checklist evidence (D344).** 9. Any rollback across a migration boundary. 10. Each SOON-card flip with its capture. 11. Production promotion / partner activation.

---

## Overflow evidence E1–E7

### E1 — K3 premise falsified (D339)
- `apps/web/src/server/auth.ts:134`: `const { user } = await getAuth().api.signUpEmail({` — signup is an IN-PROCESS api call inside the D117 transaction.
- `apps/web/src/app/login/actions.ts:34`: `await getAuth().api.signInEmail({ body: { email, password } });` — same.
- `apps/web/src/app/api/auth/[...all]/route.ts:27`: `const ALLOWED_ENDPOINTS = new Set(["get-session", "sign-out"]);` — `/sign-up/email` and `/sign-in/email` are 404 on the HTTP handler.
- better-auth 1.7.1 (vendored `node_modules/better-auth`): the limiter is invoked ONLY in the router's `onRequest` — `dist/api/index.mjs:168`. `dist/api/to-auth-endpoints.mjs` (the in-process `auth.api.*` path) contains zero `rateLimit` references.
- Defaults, for the record (`dist/context/create-context.mjs:169-174`): `enabled ?? isProduction`, `window 10`, `max 100`, storage memory. None of this reaches signup/login here.
- `trustedOrigins`: only the mounted handler runs `originCheckMiddleware`; default trusted set = the `BETTER_AUTH_URL` origin (`dist/utils/url.mjs:71`). Nothing to add.

### E2 — `/status` is SSG → runtime env for the monitor URL is impossible
- `apps/web/src/app/status/page.tsx:43` — prerendered. Env must be baked at `next build`, i.e. the D329 ARG/ENV shape (`apps/web/Dockerfile:52-53`).
- Pinned sentence: `status/page.tsx:140-141` and `status/status.test.ts:226-231`.

### E3 — config-as-code is for repo-connected services only (D335)
- Facts §8: the config file is set "on the service settings page … the absolute path to the file in your repository" — an image-sourced service has no repository. Undocumented for image services → nothing rests on it. R8's field list carries no `image` field.

### E4 — images.yml today (T1 facts)
- `.github/workflows/images.yml:26-33`: `on: pull_request / workflow_dispatch`; `concurrency: group: images-${{ github.head_ref || github.ref }} / cancel-in-progress: true`; `permissions: contents: read`; one job `images`. No push trigger, no login, no push step.
- The D41 pattern to copy verbatim: `.github/workflows/stack.yml:96-112` — `push: branches: [master]` + `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
- Web image: `apps/web/Dockerfile:67` `ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0`, `:91` `CMD ["node", "apps/web/server.js"]`. Ingest: `services/ingest/Dockerfile:13-14` `USER nonroot:nonroot`, `EXPOSE 4317 4318 8080`; Go reads only `OBSTACK_*_ADDR` (`config.go:70-72`).
- CI probes: mock `GET /app` (`images.yml:89`), live `GET /login` (`:106`); compose healthcheck web `/login` (`docker-compose.yml:185`), ingest `/ingest healthcheck` → admin `/healthz` (`main.go:45-51`, `:469`). The :4318 mux has only `POST` routes (`receive/http.go:57,64,76,77`) → `GET /healthz` on the public port is 404 by construction.

### E5 — literal carriers (every file per literal)
- `polar-sandbox`: `apps/web/src/server/billing/{client.ts:20,24,29,30,37; polar.ts:49,85; types.ts:18,21; reporter.ts:156; fake.ts:47; billing.test.ts:84,90,102; reporter.test.ts:209,213}`, `deploy/compose/e2e-drive.mjs:149`. NOT in `deploy/compose/.env.example`, `deploy/helm/**`, or `apps/web/src/content/docs/**`.
- `coming-soon` / "coming soon": `components/connections/connectors.ts:141-162` (+ 14 other cards, untouched), `connectors.test.ts:118-122`, `mock/connectors.test.ts:48-50,116-117`, `shell/shell-honesty.test.ts:230`, `app/landing-fence.test.ts:706-717` (19/3/16 counts + breadth sentence), `app/page.tsx:247,281`, `components/marketing/ScreensShowcase.tsx:38`, `lib/docs/mirror.test.ts:333-337`, `content/docs/connectors/overview/index.mdx:41-50`, `content/docs/connectors/vercel-log-drains/index.mdx:9-10`, `content/docs/connectors/aws-cloudwatch/index.mdx:9-11`, `content/docs/what-obstack-does-not-do/index.mdx:64-68`, `deploy/cloudwatch-forwarder/README.md:7-11`, `content/changelog/README.md:32` (generic, untouched).
- "External uptime monitoring": `status/page.tsx:140`, `status/status.test.ts:229`.
- hosting-denial copy: `app/page.tsx:162,550` (`:157` is a JSX comment), `app/signup/page.tsx:52-53`, `app/login/page.tsx:47-49`, `app/invite/[id]/page.tsx:172`, pins `app/signup/mock-mode.test.ts:92,130`.
- "+ usage": `app/page.tsx:446` only (fence row L77 `.planning/2026-08-30-s4.4-landing-fence.md:80`).
- "installed from this repo today": `app/page.tsx:395` only (fence L71 `:74`).
- fake Explain sentence: `server/explain/fake.ts:63-64`; pins `explain.test.ts:166` (substring `OBSTACK_EXPLAIN_MODE=fake`), `deploy/compose/e2e-drive.mjs:2159` (prefix "This deployment runs Explain in fake mode").
- `OBSTACK_STATUS_MONITOR_URL`, `appHost`, `server/rate-limit.ts`: no matches anywhere — free names.

### E6 — operator state measured
- `railway 5.45.10`; `gh auth status` scopes `gist, read:org, repo, workflow`; repo `Ziadabdelsalam/obstack` private → GHCR namespace `ghcr.io/ziadabdelsalam/…`.
- Vendored gRPC exporter present: `node_modules/@opentelemetry/exporter-trace-otlp-grpc` (the D336 staging proof needs no new dependency).

### E7 — why production never runs `fake` or `polar-sandbox` (D344)
- `billing/fake.ts` + the return path write the plan row on a checkout that charged nobody; `polar-sandbox` does the same against test cards. On a public host either is a self-service free Pro and a fictional checkout (D13). Hence the production environment is configured with the production rail BEFORE its first deploy, and the app cut-over is gated on U14.
