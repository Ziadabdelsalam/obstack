# obstack on Railway — operator runbook

Five services, one Railway project, two environments (`staging` → Railway-issued
domains, `production` → `obstack.dev`). Config-as-code (`railway.json`) is
REFUSED for every service here: Railway's config-file mechanism is documented
only for repository-connected services, and all five services here are
image-sourced (D335/E3 — the field list Railway publishes for that file has no
`image` key). **This table is the settings record** — set every field below by
hand in the Railway dashboard (or `railway variables set` / `railway domain`
from the CLI) per service, per environment.

Deploy is always: CI (`images.yml`) publishes an immutable `sha-<sha>` tag to
GHCR → an operator points the Railway service's image reference at that tag →
redeploy. Nothing here builds from the repo on Railway; nothing here uses
`railway up`.

## 1. Per-service settings

| service | image reference | `PORT` | healthcheck (timeout 120s) | restart policy | replicas | region | volume mount |
|---|---|---|---|---|---|---|---|
| `marketing` | `ghcr.io/ziadabdelsalam/obstack-web:mock-sha-<sha>` | `3000` (explicit — Next standalone honours `PORT`; Railway's injected value would move the listener) | `GET /app` | ALWAYS | `1` (stateless mock build; one replica is the launch size, nothing here needs more) | EU West | — |
| `web` | `ghcr.io/ziadabdelsalam/obstack-web:live-sha-<sha>` | `3000` (explicit, same reason) | `GET /login` | ALWAYS | `1` (**required**, not merely chosen: D339's limiter keeps its window in this process's memory — §6) | EU West | — |
| `ingest` | `ghcr.io/ziadabdelsalam/obstack-ingest:sha-<sha>` | `8080` (healthcheck routing only — the Go binary ignores `PORT`, it reads `OBSTACK_*_ADDR` below) | `GET /healthz` on target port `8080` | ALWAYS | `1` (NOT R4 — `ingest` mounts no volume: it is the single migration runner, and the compose README's "exactly one migration runner per upgrade" is what pins it) | EU West | — |
| `clickhouse` | `ghcr.io/ziadabdelsalam/obstack-clickhouse:sha-<sha>` | `8123` | `GET /ping` | ALWAYS | `1` (R4) | EU West | `/var/lib/clickhouse` |
| `postgres` | `postgres:17.11` | — (no `PORT` override; Postgres speaks the wire protocol on `5432`, not HTTP — no healthcheck path applies) | none | ALWAYS | `1` (R4) | EU West | `/var/lib/postgresql/data` (`PGDATA=/var/lib/postgresql/data/pgdata`) |

**Restart policy — `ALWAYS`, uniformly, and why it is not left at whatever
Railway defaults to.** R8's field list in
`.planning/2026-08-31-s5-railway-facts.md:117` records only the field NAMES
(`restartPolicyType`, `restartPolicyMaxRetries`) — it quotes neither the
allowed values nor the default, so nothing here may claim one (M12). Confirm
the option set in the service settings page at T0 and correct this column if
Railway spells it differently. The reason for `ALWAYS` over a retry-capped
policy is a measured Railway behaviour, R9: **"Railway does not monitor the
healthcheck endpoint after the deployment has gone live"** — the healthcheck
column above is a ROLLOUT GATE only (a new deployment must answer 200 before
it replaces the old one), never ongoing liveness. So once a service is live,
the restart policy is the only thing that brings it back. All five of these
are long-running servers, none is a job or a cron: a policy with a bounded
retry count can exhaust it during a transient dependency outage and leave
`ingest` down for good, silently dropping every customer's telemetry with no
healthcheck watching. `ALWAYS` keeps retrying and recovers by itself.

### Public domains → target ports

| domain | service | target port |
|---|---|---|
| `obstack.dev`, `www.obstack.dev` | `marketing` | `3000` |
| `app.obstack.dev` | `web` | `3000` |
| `ingest.obstack.dev` | `ingest` | `4318` (OTLP/HTTP + `/v1/integrations/{vercel,cloudwatch}`) |
| `ingest-grpc.obstack.dev` | `ingest` | `4317` — **only** if the D336 staging gRPC proof passes (one span exported over TLS via the vendored `@opentelemetry/exporter-trace-otlp-grpc`, arrival confirmed in the UI by the K0 walker). If it fails, this domain is never created and `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT` stays unset. Record the verdict here: `gRPC staging proof: PASS / FAIL — date, evidence link ___` |
| — | `ingest` admin (`:8080`, `/healthz` `/metrics`) | **never public** — private networking / healthcheck routing only |
| — | `clickhouse`, `postgres` | **never public** — reached only over `<service>.railway.internal` from `web` and `ingest` |

## 2. Variable names per service (names only — see `.env.example`)

| service | variable | source |
|---|---|---|
| `marketing` | `OBSTACK_DATA_MODE` | fixed value `mock` (this table) |
| `web` | `OBSTACK_DATA_MODE` | fixed value `live` (this table) |
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

## 3. Registry

Railway **Pro** plan is required to configure private-registry credentials
(R5) — verify this at T0 before anything else here. Credential: a **classic**
GitHub PAT scoped `read:packages` only (fine-grained PATs cannot read GHCR),
**90-day expiry**, entered once into Railway's registry credentials (never as
a service variable, never in git). Record the expiry date so a future
operator knows when to rotate it:

> GHCR PAT expiry: **______________** (fill in at issuance)

**Deploy procedure:** point the service's image reference at the new
`sha-<sha>` (or `live-sha-<sha>` / `mock-sha-<sha>`) tag → redeploy. Never
move a mutable tag.

**Rollback:** dashboard **Rollback** on the service (restores both the image
reference and the variable snapshot at that deployment) — or set the image
reference back to the previous `sha` tag and redeploy. Datastores
(`clickhouse`, `postgres`) are **never** rolled back. A rollback that would
cross a schema-migration boundary (i.e. the target sha predates a migration
`ingest` already applied) is **not** performed here — escalate to the advisor
first (D346). Verify every rollback with the T2 smoke suite (§7) plus
`railway logs` boot lines (ingest's migration summary, web's mode stamp) —
never by exit code alone.

## 4. Staging → production

One Railway project, two environments:

- **staging** — Railway-issued domains (`*.up.railway.app` per service).
  `BETTER_AUTH_URL` and `OBSTACK_APP_URL` are set to that Railway domain (not
  a custom domain). `OBSTACK_BILLING_MODE=polar-sandbox` against the Polar
  sandbox org.
- **production** — the custom domains in §1. `OBSTACK_BILLING_MODE=polar`
  against the Polar production org, configured **before** production's first
  deploy. Production never runs `OBSTACK_BILLING_MODE=fake` or
  `polar-sandbox` at any point (D344) — a public host running either is a
  free self-service Pro plan and a fictional checkout.

## 5. DNS cut-over (Squarespace, D347)

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
keyed `(ip, action)`: **signup 5/IP/1h, login 10/IP/10min**. IP is the first
hop of `x-forwarded-for`; a request with no IP is allowed through with a
logged warning (fail-open, loud — never a silent bypass).

**What the first hop is worth depends on Railway, and the R-facts do not say.**
The first hop is the right choice only if Railway's edge REPLACES any
client-supplied `x-forwarded-for`; if it APPENDS to one, the first hop is a
value the caller typed, and rotating it defeats this limiter entirely.
Railway's forwarded-header behaviour is not quoted anywhere in
`.planning/2026-08-31-s5-railway-facts.md` — D339 chose the first hop
knowingly and made staging settle it. So the K0 staging gate proves TWO
things, not one: (a) `railway logs --service web` contains no
"could not determine a client IP" line (the header arrives at all — a
BLOCKing check), and (b) a signup replayed with a forged
`x-forwarded-for: 1.2.3.4` header still counts against the real caller's
budget (the sixth is refused). If (b) fails, the header is
attacker-controlled, this limiter is advisory only, and that is an
ESCALATION to the advisor before launch — not something to patch here.

**This is correct at exactly one `web` replica** (§1 pins `web` to
`replicas: 1`). A second `web` replica would split traffic across two
in-memory limiter instances and silently double every operator-visible
limit (10/IP/1h signup, 20/IP/10min login) — do not scale `web` horizontally
without moving this state out of process first.

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
