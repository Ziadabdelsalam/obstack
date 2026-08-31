# obstack on Railway — operator runbook

Five services, one Railway project, two environments (`staging` → Railway-issued
domains, `production` → `obstack.dev`). **No Pro plan, GitHub-connected builds
(D356/D357):** the user connects the Railway GitHub App instead of buying Pro
for a private-registry credential — so
`web`, `marketing`, `ingest` and `clickhouse` are now GitHub-connected
services that Railway builds from this repo with its Dockerfile builder,
exactly like the compose/chart builds already do, and config-as-code
(`railway.json`, §1 below) is valid again for those four. `postgres` stays a
plain `postgres:17.11` pull — a public Docker Hub image needs no GitHub
build and works on any plan.

**Plan, as measured (D358):** the workspace is on the **free trial** today
(`railway volume list` → `0MB/500MB` on the staging `postgres` volume).
Staging runs on the trial; **W4 (production) waits for the $5 Hobby
subscription** — see "Capacity (D358)" in §7. Every "any plan" statement
here means trial included.

**Every `deploy/railway/<service>/railway.json` file must be pointed at by
its absolute repo path in that service's settings page** — Railway does not
discover these files on its own (R8, `.planning/2026-08-31-s5-railway-facts.md`
§8): `deploy/railway/web/railway.json`, `.../marketing/railway.json`,
`.../ingest/railway.json`, `.../clickhouse/railway.json`.

## 1. Per-service settings

| service | source | root directory | Dockerfile | branch — staging / production | region | volume mount |
|---|---|---|---|---|---|---|
| `marketing` | GitHub `Ziadabdelsalam/obstack` | `/` | `apps/web/Dockerfile` | `master` (auto-deploy) / `production` (operator fast-forwards) | EU West | — |
| `web` | GitHub `Ziadabdelsalam/obstack` | `/` | `apps/web/Dockerfile` | `master` / `production` | EU West | — |
| `ingest` | GitHub `Ziadabdelsalam/obstack` | `services/ingest` | `Dockerfile` (default lookup — resolves to `services/ingest/Dockerfile`) | `master` / `production` | EU West | — |
| `clickhouse` | GitHub `Ziadabdelsalam/obstack` | `/` | `deploy/railway/clickhouse/Dockerfile` | `master` / `production` | EU West | `/var/lib/clickhouse` |
| `postgres` | Docker Hub image `postgres:17.11` (public — works on any plan, no GitHub build) | — | — | — (image tag pinned, not branch-tracked) | EU West | `/var/lib/postgresql/data` (`PGDATA=/var/lib/postgresql/data/pgdata`) |

Region is set **by hand in the dashboard** on all five services — not
because the field does not exist. `deploy.region` IS in the live schema
(`https://railway.app/railway.schema.json`, `anyOf: string | null`), but the
schema enumerates **no** accepted values, and the two identifier strings in
evidence disagree: the docs example uses `europe-west4-drams3a` (R13) while
the staging `postgres` service was created with `ams` (ship log,
2026-08-31 W3 step 1). Writing an unverified string into four config files
fails four deploys at once, so it stays dashboard-set until **T0 records the
identifier Railway actually accepted** for a service in this workspace;
pinning `deploy.region` to that exact string is then a one-line follow-up on
all four files. `multiRegionConfig` (a per-region replica map) is a
different, multi-region field and is not what this launch wants.

### Public domains → target ports

Railway routes a custom domain to the domain's **Target Port** if one is
set, and otherwise to the port in `PORT` (R1). `ingest` sets `PORT=8080`
for healthcheck routing only (§2) — so **an ingest domain created without an
explicit target port would publish the admin port** (`/healthz`, `/metrics`)
instead of OTLP. Every domain below is created with its port:
`railway domain <domain> --port <target port>`.

| domain | service | target port |
|---|---|---|
| `obstack.dev`, `www.obstack.dev` | `marketing` | `3000` |
| `app.obstack.dev` | `web` | `3000` |
| `ingest.obstack.dev` | `ingest` | `4318` (OTLP/HTTP + `/v1/integrations/{vercel,cloudwatch}`) |
| `ingest-grpc.obstack.dev` | `ingest` | `4317` — **only** if the D336 staging gRPC proof passes (one span exported over TLS via the vendored `@opentelemetry/exporter-trace-otlp-grpc`, arrival confirmed in the UI by the K0 walker). If it fails, this domain is never created and `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT` stays unset. Record the verdict here: `gRPC staging proof: PASS / FAIL — date, evidence link ___` |
| — | `ingest` admin (`:8080`, `/healthz` `/metrics`) | **never public** — private networking / healthcheck routing only |
| — | `clickhouse`, `postgres` | **never public** — reached only over `<service>.railway.internal` from `web` and `ingest` |

### Config-as-code (`railway.json`, D357)

`deploy/railway/{web,marketing,ingest,clickhouse}/railway.json` carry
everything the facts file's §8 field list actually documents and this launch
needs — nothing else (no speculative `builder`, `startCommand`, etc.):

- `build.dockerfilePath` — the Dockerfile column above. For `web`,
  `marketing` and `clickhouse` the Root Directory is `/`, so repo-root- and
  root-directory-relative are the same string and the question does not
  arise. For `ingest` (Root Directory `services/ingest`, `dockerfilePath`
  `Dockerfile`) it DOES: whether `dockerfilePath` resolves against the Root
  Directory the way `RAILWAY_DOCKERFILE_PATH` does is **Unknown 9** in
  `.planning/2026-08-31-s5-railway-facts.md` — undocumented, not assumed
  here. **The first staging `ingest` build measures it**, and it fails loud
  either way (a repo-root resolution looks for `/Dockerfile`, which does not
  exist, and the build errors — it cannot silently build the wrong image).
  If it fails: delete `dockerfilePath` from `deploy/railway/ingest/railway.json`
  and set the documented env-var mechanism instead — the service variable
  `RAILWAY_DOCKERFILE_PATH` (D356's own wording), value measured on that
  build (`Dockerfile` or `services/ingest/Dockerfile`), recorded here.
- `build.watchPatterns` — scoped per service so one merge does not rebuild
  all four. The list per service is exactly what that service's build
  context reads: `web`/`marketing` → `apps/web/**`, `packages/**`,
  `package.json`, `package-lock.json`, **`services/ingest/pricing/prices.json`**
  (`apps/web/Dockerfile:34` `COPY`s it — the one pricing table
  `apps/web/src/server/ingest-health.ts` shares with Go's
  `services/ingest/pricing/pricing.go`; without it a merge that edits only
  that file rebuilds `ingest` and leaves `web`/`marketing` serving the old
  prices); `ingest` → `services/ingest/**` (its whole build context, since
  its Root Directory is `services/ingest` and its Dockerfile is `COPY . .`);
  `clickhouse` → `deploy/railway/clickhouse/**`, `deploy/compose/clickhouse/**`
  (the shared `users.d` XML `clickhouse`'s Dockerfile `COPY`s from).
  **Each list also contains that service's own `deploy/railway/<service>/railway.json`**
  — a watch list that does not watch the deploy config means editing this
  file alone never triggers the redeploy that would apply it. Cross-check
  when the web build changes: `apps/web/Dockerfile.dockerignore`'s
  allow-list (`!package.json !package-lock.json !apps/web
  !packages/obstack-js !services/ingest/pricing/prices.json`) IS the
  authoritative list of paths that build reads.
- `deploy.healthcheckPath` — `web` `/login`, `marketing` `/app`, `ingest`
  `/healthz` (on target port `8080` — set `PORT=8080` per §2 so Railway
  healthchecks the right port), `clickhouse` `/ping`. `postgres` has no
  Dockerfile-built service and no HTTP healthcheck — no `railway.json`.
- `deploy.healthcheckTimeout` — `120` on all four.
- `deploy.restartPolicyType` — `ALWAYS` on all four. The enum spelling is
  confirmed against the live schema (`ON_FAILURE` / `ALWAYS` / `NEVER`).
  `ALWAYS` over a retry-capped policy because of R9: **"Railway does not
  monitor the healthcheck endpoint after the deployment has gone live"** —
  the healthcheck is a ROLLOUT GATE only (a new deployment must answer 200
  before it replaces the old one), never ongoing liveness. Once a service is
  live the restart policy is the only thing that brings it back, and all
  four are long-running servers, none a job or a cron: a bounded retry count
  can exhaust itself during a transient dependency outage and leave `ingest`
  down for good, silently dropping every customer's telemetry with no
  healthcheck watching. Set the same policy by hand on `postgres`, which has
  no `railway.json`.
- `deploy.numReplicas` — `1` on all four (R4 for the two volume-backed
  services; `web` because D339's rate limiter keeps its window in this
  process's memory, §6; `ingest` because it is the single migration runner).

Validate a file against the schema before it ships:
`npx --yes ajv-cli validate -s https://railway.app/railway.schema.json -d deploy/railway/web/railway.json`
(repeat per file). If the schema fetch is ever blocked, fall back to
`python3 -m json.tool deploy/railway/<service>/railway.json` for syntax plus
a manual field-name check against
`.planning/2026-08-31-s5-railway-facts.md` §8.

### Build ARGs (D356) — first staging build MEASURES the mechanism

`apps/web/Dockerfile` already declares three `ARG`s that `next build` reads
while prerendering (`:42-43` `OBSTACK_DATA_MODE`, `:52-53` `OBSTACK_APP_ORIGIN`,
`:60-61` `OBSTACK_STATUS_MONITOR_URL`) — nothing here adds a fourth. Railway
auto-passes a service variable as the build ARG of the same name **only**
because the Dockerfile already declares that `ARG` — this is documented as
NOT automatic in general (`.planning/2026-08-31-s5-railway-facts.md` §6), so
the first staging build is where the mechanism gets proven, not assumed:

- read the Railway build log for the three `ARG` values as printed during
  the build step;
- confirm `marketing`'s boot line is free of the
  `refusing to start: this artifact was built with OBSTACK_DATA_MODE=mock
  baked in, but is running with OBSTACK_DATA_MODE=…` refusal (i.e. the build
  ARG and the runtime variable — §2 — agree);
- confirm the rendered "Create your workspace" CTA href on the built
  marketing page equals the app origin (production: `https://app.obstack.dev`;
  staging: the staging `web` service's Railway domain).

A miss on any of the three is an **escalation to the advisor**, never a
workaround (e.g. never hand-editing the Dockerfile to hardcode a value).

### Plan checks (T0, D357/D358)

- **Attach `app.obstack.dev` to the production `web` service BEFORE any DNS
  edit** (§5) — this is what surfaces the CNAME/ALIAS target Squarespace
  needs. Whether the plan below Pro supports custom domains at all is
  **Unknown 4** in the R-facts. If Railway refuses the attach, **Pro is
  mandatory for the cut-over** (the user's call) — this blocks **W4**, not
  W3; everything above this line works without it.
- **Volume cap is a percentage watch, not an absolute number** — the cap
  moves with the plan (trial 500 MB → Hobby 5 GB → Pro 50 GB), so the
  runbook watch is 60 % alarm / 75 % act **of whatever cap
  `railway volume list` prints today** (D358, §7), never a fixed GB figure.
  On today's trial cap that is 300 MB / 375 MB. `clickhouse` is the one to
  watch (`postgres`'s identity + saved-view data is far smaller).
- **Re-read the cap after any plan change** — `railway volume list` is the
  only readout: `500 MB` = trial (today), `5 GB` = Hobby, `50 GB` = Pro.
  Buying the Hobby subscription before W4 is what raises it; record the new
  number here when it happens.
- **"Wait for CI" toggle** — T0 verifies this toggle exists on the `staging`
  environment's auto-deploy settings (not confirmed in the R-facts). Present
  → turn it ON, so staging only deploys after the GitHub Actions checks on
  that commit are green. Absent → staging deploys are **manual redeploys**
  triggered by the operator after `master`'s CI run is green (never
  auto-deploy on red).

## 2. Variable names per service (names only — see `.env.example`)

| service | `PORT` | why |
|---|---|---|
| `marketing` | `3000` | explicit — Next standalone honours `PORT`; Railway's injected value would move the listener |
| `web` | `3000` | same reason |
| `ingest` | `8080` | healthcheck routing only — the Go binary ignores `PORT`, it reads `OBSTACK_*_ADDR` below |
| `clickhouse` | `8123` | — |
| `postgres` | — | Postgres speaks the wire protocol on `5432`, not HTTP — no `PORT` override, no healthcheck path applies |

| service | variable | source |
|---|---|---|
| `marketing` | `OBSTACK_DATA_MODE` | fixed value `mock` (this table) — build ARG *and* runtime variable, same value on this service (§1 "Build ARGs") |
| `marketing` | `OBSTACK_APP_ORIGIN` | build ARG only (baked at build time, D329) — production: `https://app.obstack.dev`; staging: the staging `web` service's Railway-issued domain |
| `web`, `marketing` | `OBSTACK_STATUS_MONITOR_URL` | build ARG only (baked at build time, D342) — unset until the Better Stack status page exists; the user has chosen `https://status.obstack.dev` for when it does |
| `web` | `OBSTACK_DATA_MODE` | fixed value `live` (this table) — build ARG *and* runtime variable, same value on this service |
| `web` | `CLICKHOUSE_URL`, `CLICKHOUSE_USER=obstack_web` | fixed / this table (URL = `http://clickhouse.railway.internal:8123`) |
| `web` | `CLICKHOUSE_PASSWORD` | generated (user) — Railway variables (web) |
| `web`, `ingest` | `OBSTACK_POSTGRES_DSN` | derived from `POSTGRES_PASSWORD` (this table) — Railway variables (web, ingest) |
| `web` | `BETTER_AUTH_SECRET` | `openssl rand -base64 32` (user) — distinct value per environment |
| `web` | `BETTER_AUTH_URL` | fixed: `= OBSTACK_APP_URL` (staging: the Railway-issued domain; production: `https://app.obstack.dev`, D119/D348) |
| `web` | `OBSTACK_BILLING_MODE` | fixed per environment (staging: `polar-sandbox`; production: `polar` — **never** `fake`/`polar-sandbox` in production, D344) |
| `web` | `POLAR_ACCESS_TOKEN` | Polar dashboard (user, U14) — Railway variables (web) |
| `web` | `POLAR_WEBHOOK_SECRET` | Polar webhook endpoint (user) — Railway variables (web) |
| `web` | `OBSTACK_APP_URL` | fixed (staging: Railway domain; production: `https://app.obstack.dev`) |
| `web` | `POLAR_PRODUCT_PRO` | Polar catalog (user) — environment-bound id, not a secret |
| `web` | `OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT` | fixed: `https://ingest.obstack.dev` |
| `web` | `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT` | fixed: `https://ingest-grpc.obstack.dev` when the D336 gRPC proof passes; **unset** otherwise |
| `web` | `OBSTACK_EXPLAIN_MODE` | fixed: `fake` (K5 — no key ships) |
| `web` | `OBSTACK_EXPLAIN_API_KEY` / `ANTHROPIC_API_KEY` | not set in this launch (K5 fake-mode decision, D348) |
| `web` | `OBSTACK_EXPLAIN_MODEL`, `OBSTACK_EXPLAIN_BASE_URL` | not set in this launch (only relevant when `OBSTACK_EXPLAIN_MODE=anthropic`) |
| `ingest` | `CLICKHOUSE_DSN` | fixed: `clickhouse://obstack_ingest:<password>@clickhouse.railway.internal:9000/obstack` |
| `ingest` | `OBSTACK_POSTGRES_DSN` | see web row above (shared value) |
| `ingest` | `OBSTACK_VERCEL_DRAIN_SECRET` | unset until a drain exists (D348) — Vercel drain settings (user) when it does |
| `ingest` | `OBSTACK_OTLP_GRPC_ADDR`, `OBSTACK_OTLP_HTTP_ADDR`, `OBSTACK_ADMIN_ADDR` | defaults (code-level) — set only to override |
| `clickhouse` | `OBSTACK_CLICKHOUSE_INGEST_PASSWORD` | generated (user) — Railway variables (clickhouse, ingest) |
| `clickhouse` | `OBSTACK_CLICKHOUSE_WEB_PASSWORD` | generated (user) — Railway variables (clickhouse, web) |
| `postgres` | `POSTGRES_USER` | fixed value `obstack` |
| `postgres` | `POSTGRES_PASSWORD` | generated (user) — Railway variables (postgres); source of the two DSNs above |
| `postgres` | `POSTGRES_DB` | fixed value `obstack` |
| `postgres` | `PGDATA` | fixed value `/var/lib/postgresql/data/pgdata` |

### ClickHouse users posture (D350, D355)

The shared `users.d` file (compose, chart and this image are one source) pins
`default` to loopback — unconditionally, whatever the upstream entrypoint does
with `CLICKHOUSE_PASSWORD`. The two application users keep `::/0` and
`obstack_ingest` keeps `GRANT ALL ON obstack.*`: on Railway the project's
private network is single-tenant (only obstack's five services share it), so
**the credential is the boundary, not the network.** That only holds if the
passwords stay where the table above puts them: `OBSTACK_CLICKHOUSE_INGEST_PASSWORD`
on `clickhouse` and `ingest` ONLY, `OBSTACK_CLICKHOUSE_WEB_PASSWORD` on
`clickhouse` and `web` ONLY — never a shared-variable reference that fans a
password out to a service that does not need it. Network-scoping the app users
is refused for now (Railway documents no stable service addresses, R3).
Narrowing the ingest grant to the privileges its migrations and the retention
sweep actually use is an **M5 item with its method fixed**: derive the list by
a `SHOW GRANTS` diff against `services/ingest` migrations + the sweep's
`ALTER … DELETE`, land it in the shared XML and the chart copy, prove it red
by the compose bundle boot and the `stack` job.

**CLI service-targeting caution (measured 2026-08-31):** `railway variable`'s
`-s/--service` flag is silently IGNORED on this CLI version (5.45.10) — reads
and writes go to the LINKED service. Always `railway service link <name>`
immediately before any variable read or write, and verify with the output's
`RAILWAY_SERVICE_NAME`. A missed link is how a password rotation lands on the
wrong service while the store keeps the old credential.

**Reference caution (measured 2026-08-31):** `railway variable set 'X=${{svc.VAR}}'`
stores the RESOLVED value, not the reference — a later rotation on `svc` does
not follow. Enter cross-service references through the dashboard's variable
editor (which keeps the `${{…}}` form), or treat every DSN as a literal that
must be re-set whenever its source password rotates. The CLI's
`variable list` (any output mode) prints RESOLVED SECRET VALUES — never run it
in a logged session except `--json` piped to a key-only filter.

## 3. Deployment provenance (D356 — no registry, no PAT)

Railway no longer pulls a private image. `web`, `marketing`, `ingest` and
`clickhouse` build from the repo on every tracked-branch push (§1, §4); there
is nothing here to authenticate a registry pull for, and nothing here stores
a credential of that shape.

The CI `publish` job (`images.yml`) **stays** — it still builds and pushes
`sha-<sha>` images to GHCR (`ghcr.io/ziadabdelsalam/obstack-{web,ingest,clickhouse}`)
and re-runs the refusal matrix against the published mock image. It is now
the **artifact record**: the proof that this exact source, at this exact
commit, with this exact build configuration, passes every refusal check on a
real built image — and the ready path back to registry pulls the day Pro is
bought. Nothing at deploy time reads from this registry.

**Same-images** now rests on D251(d)'s letter rather than a shared binary:
"same source, same commit, same build configuration." Record each
deployment in the ship log as the tuple **(commit sha, Dockerfile path, root
directory, the three ARG values as printed in the Railway build log, the
boot line naming the stamp)** — proven by the T2 smoke suite (§8) plus that
boot line, per deployment, exactly as D346 already required.

**Access:** the only new credential this launch introduces is the **Railway
GitHub App grant**, installed against `Ziadabdelsalam/obstack` only (Railway's
"select repositories" install mode, never "all repositories"). Nothing else
to rotate or expire-track here — there is no PAT.

**Deploy procedure (§4 has the branch mechanics):** push to `master`
(staging, auto-deploy) or fast-forward `production` (production, operator
action, always a critical item the user confirms).

**Rollback (D346, amended for D357):** dashboard **Rollback** on the service
first, for speed — it restores both the previous deployment's build and its
variable snapshot. Then reset the `production` branch ref to that same
commit (`git push --force-with-lease origin <sha>:production`, run by the
operator with the user's confirmation) so the branch tip and the running
artifact agree again — a `production` tip that disagrees with what is
actually deployed is exactly the drift D357 exists to prevent. Datastores
(`clickhouse`, `postgres`) are **never** rolled back. A rollback that would
cross a schema-migration boundary (the target commit predates a migration
`ingest` already applied) is **not** performed here — escalate to the
advisor first. Verify every rollback with the T2 smoke suite (§8) plus
`railway logs` boot lines (ingest's migration summary, web's mode stamp) —
never by exit code alone.

## 4. Staging → production (D357 triggers)

One Railway project, two environments, each tracking a different ref:

- **staging** — tracks `master`. Auto-deploy on push, **"Wait for CI" ON**
  (deploy only after the GitHub Actions checks on that commit pass) — see
  the Hobby-plan check in §1 for what to do if that toggle turns out not to
  exist. Railway-issued domains (`*.up.railway.app` per service).
  `BETTER_AUTH_URL` and `OBSTACK_APP_URL` are set to that Railway domain (not
  a custom domain). `OBSTACK_BILLING_MODE=polar-sandbox` against the Polar
  sandbox org.
- **production** — tracks a branch literally named `production`, which the
  operator fast-forwards to the commit that just passed the K0 staging gate
  (`git push origin <sha>:production`). **The branch tip IS the deployed
  commit** — there is no other deploy trigger for this environment, and
  **every push to `production` is a critical item the user confirms**
  before it happens. The custom domains in §1. `OBSTACK_BILLING_MODE=polar`
  against the Polar production org, configured **before** production's first
  deploy. Production never runs `OBSTACK_BILLING_MODE=fake` or
  `polar-sandbox` at any point (D344) — a public host running either is a
  free self-service Pro plan and a fictional checkout.

## 5. DNS cut-over (Squarespace, D347)

0. **Before this section:** complete the Hobby-plan check in §1 —
   `app.obstack.dev` must already be attached to the production `web`
   service (that is what produces the target hostname the records below
   point at). If Railway refuses the attach on Hobby, this section is
   blocked until Pro is purchased.
1. **Before touching any record:** lower the TTL on every record involved to
   **300s**, and copy the current parked records **verbatim** into the ship
   log — that copy is the rollback plan.
2. Apex `@`: delete the parking `A` records first (an `ALIAS` conflicts with
   an `A`/`AAAA` on the same name), confirm DNSSEC is **off**, then create an
   `ALIAS` record at `@` pointing at the Railway target hostname for
   `marketing`.
3. Every subdomain (`app`, `ingest`, `ingest-grpc` if applicable, `www`) is an
   ordinary `CNAME` to its service's Railway target hostname (`@` cannot be a
   `CNAME` — that is why the apex uses `ALIAS` instead).
4. **Cut-over order:** `app` first (cert issues, smoke, then the D344
   promotion checklist) → `ingest` (+ `ingest-grpc` if it was proven) → `www`
   and the apex **last**.
5. **Rollback:** restore the parked records copied in step 1.

## 6. Signup/login rate limiting (D339)

`apps/web/src/server/rate-limit.ts` wraps the signup and login server
actions directly (better-auth's own limiter never runs on these in-process
`auth.api.*` calls, only on its HTTP router). In-memory sliding window,
keyed `(ip, action)`: **signup 5/IP/1h, login 10/IP/10min**. IP is the
RIGHTMOST hop of `x-forwarded-for` (advisor condition F-T8a on D339): every
entry to the left is client-supplied, the rightmost is the one the single
trusted proxy in front of the app — Railway's edge — writes, whether it
appends to a client-sent header or replaces it. A request with no IP is
allowed through with a logged warning (fail-open, loud — never a silent
bypass).

**The rightmost hop is only the client's address if Railway's edge is the
only proxy in the path** — the R-facts do not quote Railway's forwarded-header
behaviour (`.planning/2026-08-31-s5-railway-facts.md`), so the K0 staging
gate proves TWO things, not one: (a) `railway logs --service web` contains no
"could not determine a client IP" line (the header arrives at all — a
BLOCKing check), and (b) a signup replayed with a forged
`x-forwarded-for: 1.2.3.4` header still counts against the real caller's
budget (the sixth is refused) — the forged value must never open a fresh
bucket. If (b) fails, the header is attacker-controlled, this limiter is
advisory only, and that is an ESCALATION to the advisor before launch — not
something to patch here.

**This is correct at exactly one `web` replica** (§1's `railway.json` pins
`web` to `numReplicas: 1`). A second `web` replica would split traffic
across two in-memory limiter instances and silently double every
operator-visible limit (10/IP/1h signup, 20/IP/10min login) — do not scale
`web` horizontally without moving this state out of process first.

## 7. Backups

Volume-loss risk on `clickhouse` and `postgres` depends on a Railway
dashboard feature not documented in the facts gathered for this plan.
**Operator fills this in at T0, before production carries partner data:**

> Volume Backups feature: **present / absent** (circle one, date checked: ______)
>
> - If **present**: daily backups enabled on both the `clickhouse` and
>   `postgres` volumes before any production data lands.
> - If **absent**: **no backups exist** — a volume loss loses partner data.
>   A manual dump procedure is an M5 item, not built as part of this launch.

### Capacity (D358)

- **Trial vs Hobby.** The Railway workspace is on the free **trial** today —
  `railway volume list` measured the staging `postgres` volume at
  `0MB/500MB` (trial cap 500 MB; Hobby 5 GB; Pro 50 GB,
  `.planning/2026-08-31-s5-railway-facts.md:51`). Staging proceeds on the
  trial — every staging proof stays meaningful at that size. **Production
  datastore volumes are never created on the trial; W4 (production) waits
  for the $5 Hobby subscription** — 500 MB cannot promise five free-tier
  partners at the top of the row-cost bracket, and a trial-credit expiry is
  an outage by billing, not by capacity.
- **Hobby budget.** 5 GB is sized against five free-tier partners: free tier
  50k events/mo retained 7 days, Pro tier 1M events/mo retained 30 days
  (`services/ingest/pgmigrations/0005_metering.sql:129`), the retention
  sweep runs daily (`retention.go:65`). Usable capacity is **half the
  nominal cap** (merge headroom — ClickHouse needs working room beside live
  data). Bytes/row on disk is **unmeasured** today — bracket it 200 B–2 KB
  until the measurement below lands.
- **Pro trigger.** Pro (50 GB) becomes mandatory when measured bytes/row ×
  projected resident rows exceeds **2.5 GB**, or the ClickHouse volume
  passes **60 %** — whichever comes first. This is a **user decision with
  the number in hand**, and a **critical item**: it must be made before the
  first Pro-plan partner's ingest ramps, not discovered after.
- **Measurement** (after the K0 walk plus 24h of staging traffic):
  ```sql
  SELECT database, table, sum(rows), formatReadableSize(sum(bytes_on_disk))
  FROM system.parts WHERE active GROUP BY database, table
  ```
  `obstack`-database rows give bytes/row per table; `system`-database rows
  measure what ClickHouse's own log tables are burning — six of them are
  gone and `query_log` is capped at 7 days (F-T3b below), so what shows up
  here is the residue, and any `system` table growing anyway is a finding.
- **Watch.** `railway volume list` weekly — no monitor can read Railway
  volume usage, so this is a manual operator watch, not an automated one.
  Alarm at **60 %** of cap, act (buy Pro or trim) at **75 %**.
- **Postgres.** KB-scale per workspace; idle usage ≈ base install +
  recycled WAL ≈ **120 MB**. More than **200 MB after 24h** of staging
  traffic is an anomaly — escalate rather than assume it will plateau.
- **F-T3b — done, in this image.** ClickHouse's own `system.*_log` tables
  carry **no TTL by default**, so `deploy/railway/clickhouse/config.d/obstack-logs.xml`
  (baked in by the image's second `COPY`) removes `metric_log`,
  `asynchronous_metric_log`, `trace_log`, `part_log`, `query_thread_log`
  and `text_log`, and gives `query_log` a 7-day TTL. Measured on a built
  container, not assumed: none of the six appear in
  `SELECT name FROM system.tables WHERE database='system' AND name LIKE '%_log'`
  after `SYSTEM FLUSH LOGS`, and `query_log`'s `engine_full` reads
  `… TTL event_date + toIntervalDay(7) …`. The file touches logging only —
  `users.d/obstack-users.xml` and the D350 `default`-user loopback pin are
  unchanged and still hold with `CLICKHOUSE_PASSWORD` set.
  **Still uncapped** (outside D358's list, watch them in the measurement
  above before adding more config): `system.error_log` and
  `system.query_metric_log` carry no TTL either.

See also the volume-cap watch in §1 — it is a percentage of whatever cap
`railway volume list` prints, and a full volume fails writes long before it
is a backups problem.

## 8. Smoke test

```
OBSTACK_SMOKE_MARKETING_URL=https://obstack.dev \
OBSTACK_SMOKE_APP_URL=https://app.obstack.dev \
OBSTACK_SMOKE_INGEST_URL=https://ingest.obstack.dev \
OBSTACK_SMOKE_INGEST_GRPC_URL=https://ingest-grpc.obstack.dev \
OBSTACK_SMOKE_API_KEY=<operator-issued key, revoked after use> \
npx tsx deploy/railway/smoke.ts
```

Any URL left unset skips that host's probes with a printed `SKIPPED (unset)`
line — never silently. `OBSTACK_SMOKE_INGEST_GRPC_URL` and
`OBSTACK_SMOKE_API_KEY` are optional; the gRPC leg only runs when both a
gRPC URL and an API key are set. Exit code is non-zero if any probe fails.
Run this against `staging` before the K0 qa-team pass, and again against
`production` after each cut-over step in §5 and after every deploy/rollback
in §3.
