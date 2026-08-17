# obstack compose bundle

The local backend for obstack: ClickHouse, the ingest service, and the demo agent
app that generates traffic. The web app is **not** containerized in Phase 1 —
run it with `npm run dev` from the repo root and point it at the ClickHouse
published here.

## Run

```bash
cd deploy/compose
docker compose up -d clickhouse
```

`docker compose ps` reports `healthy` once the server answers `SELECT 1`.

The whole Phase 1 pipeline — ClickHouse, the ingest service, and the demo agent
app that generates traffic — comes up with:

```bash
cd deploy/compose
docker compose --profile demo up -d --build
```

Ingest applies the schema at boot, so a clean checkout needs nothing else. See
[Smoke test](#smoke-test--the-phase-1-exit-criterion) below to prove it works.

## Collector — optional OTLP + filelog route

A second, opt-in path into ingest, alongside the default `demo → ingest`
one above (D39/Q2): apps can route their OTLP through `obstack-collector`
instead of straight at `ingest:4318`, which buys filelog tailing of
container stdout and (on Kubernetes) `k8sattributes` pod enrichment. It is a
compose **profile**, not a change to the default path — `demo → ingest` and
`smoke.sh` above are byte-untouched by it.

```bash
bash deploy/collector/up.sh
```

See `deploy/collector/README.md` for the collector's own config, its image
pin and verification, and the filelog exclusion pattern (the mechanism that
keeps a container's logs from landing twice when it already ships via
OTLP) documented in terms a customer could copy.

## Smoke test — the Phase 1 exit criterion

Phase 1 is done when a trace emitted by an app instrumented with plain OpenTelemetry
lands in ClickHouse and renders in the real trace view: **every layer, one trace**.
The assertable half of that is one command, run from the repo root:

```bash
bash deploy/compose/smoke.sh
```

It boots the stack (`--profile demo`, `--build`), waits for every container to
report healthy, fires `POST localhost:8000/chat` at the demo agent, and then
asserts through the web facade — `smoke.ts` calls `searchTraces()` and `getTrace()`
from `apps/web/src/server/data.ts` with `OBSTACK_DATA_MODE=live`, the same module the app
renders from, run under `npx tsx --conditions react-server` so the `server-only`
guard resolves. No Next server and no test-only API route sit in between.

The trace the demo just emitted must, within 30s:

- **list** — appear in `searchTraces()`, with a root service and a `trace_summaries`
  `span_count` that matches the number of span rows (the rollup merged correctly),
  under an exact filtered total of at least one (the page and the count query agree);
- **resolve** — come back from `getTrace()` with all four layers, `api`, `agent`,
  `tool` and `llm`, under that one `trace_id`;
- carry a populated LLM span — model, prompt, completion and non-zero token counts —
  and a non-zero trace cost, so the ingest-time pricing path is proven alive;
- carry **at least one log** stamped with the same `trace_id`.

Anything missing prints as a list of specific problems and exits non-zero.
Spans of one trace can arrive across ingest batches, so the script polls rather
than sleeping a fixed interval; the usual run takes ~20s, most of it the build.

> Migrations are tracked by filename, not by checksum, and pre-release migrations
> are edited in place. A volume created before a schema change keeps the old
> tables, so run `docker compose --profile demo down -v` first if the stack has
> been up across one. A clean checkout never needs this.

## Manual browser verification

`smoke.sh` proves the data; the browser proves the render. Once it passes, with
the stack still up, from the repo root:

```bash
OBSTACK_DATA_MODE=live \
CLICKHOUSE_URL=http://127.0.0.1:8123 \
CLICKHOUSE_USER=obstack_web \
CLICKHOUSE_PASSWORD=obstack_web_dev \
  npm run dev
```

Open <http://localhost:3000/app/traces> and click the newest trace. Expect the
full waterfall — API → agent step → tool call → LLM call, each on its own layer
lane — the logs rail populated with the correlated log lines, and the LLM span's
prompt, completion, token counts and cost in the span detail panel. Every span,
log line, token count and cost on that page comes from ClickHouse: surfaces not
yet wired to real data carry a `SAMPLE DATA` badge (D21), unwired widgets on a
wired page carry a `SAMPLE` chip (F6), and in live mode the shell drops the demo
chrome it cannot back — the throughput ticker, the region tag and the free-tier
banner are simply absent (F7). What is left unmarked is the fixed app furniture:
the notification bell's unread count and the account menu are still demo content
until M3 owns notifications and auth.

## Exit evidence — the S2.3 criterion (search, pagination, saved views)

`smoke.sh` proves one trace lands whole. The evidence run proves the two wired
*surfaces* — the traces list and `/app/logs` — actually search real data, with
real totals, real pagination and saved views that survive a reload. One command
from the repo root, and it is the same command CI-adjacent reviewers and humans
run (S2.1 L3):

```bash
bash deploy/compose/exit-evidence.sh
```

It destroys the compose volumes first, on purpose: the claim is about a stack
built from nothing. Then it runs `smoke.sh`, seeds a dedicated workspace
(`exit-seed.mjs`, 220 traces — deliberately more than the 200-row page — and
245 log rows, more than the 200-row cap), counts that workspace **in
ClickHouse** so every "N of M" the UI prints is checked against a denominator
the app did not compute, serves the production build against it, and asserts
the surfaces with `curl` and with a real headless browser
(`exit-browser.mjs`, over CDP). It prints one `ok`/`FAIL` line per claim and
exits non-zero on any failure; artifacts land in a temp directory it names
(override with `OUT_DIR=...`).

Three properties of the harness are worth knowing before changing it:

- **It only measures processes it started itself.** If anything already answers
  on the app port (`APP_PORT`, 3210) or the CDP port (`CDP_PORT`, 9333) the run
  refuses and exits non-zero, instead of asserting against a leftover server
  from an earlier run — which serves an *older build* — or a browser carrying
  somebody else's `localStorage`, which is what "the saved view survived" is
  about. It also kills its own server and browser on the way out, `npm exec`
  child included.
- **It builds with the same environment it serves with.** The app layout decides
  the `SAMPLE DATA` badge from the data mode, and a statically prerendered route
  bakes that decision at *build* time — so a mock-mode build served in live mode
  ships unwired pages with no badge at all. Any deployment has the same
  property: build in the mode you will serve.
- **The badge check carries a positive control**, an unwired route that must
  still show the badge. Without it, "no badge on `/app/traces`" would also pass
  if the badge had been deleted everywhere.

The dataset is designed so the free-text legs are falsifiable end to end: one
token exists *only* inside a span's `prompt` column, another *only* inside a log
row's `body`, and a third *only* on a D42 content-carrier row (empty body). The
first two must be findable from the traces list; the third must be findable
there too and must be invisible to `/app/logs`, which searches bodies only
(D51(e)).

The seeder refuses to run twice into a non-empty workspace. It cannot delete —
the ingest user has no mutation grant — so a second run would duplicate every
row and silently inflate the counts the evidence checks; start from clean
volumes instead.

Ports, published on `127.0.0.1` only — the dev passwords below live in this
repo, so nothing is exposed to the network; services inside compose reach the
server as `clickhouse:9000` instead:

| Port | Protocol | Used by |
|------|----------|---------|
| 8123 | HTTP     | the web app (`@clickhouse/client`), run from the host |
| 9000 | native   | `clickhouse-client` from the host (ingest uses the compose network) |

## Users

Two users, defined in `clickhouse/users.d/obstack-users.xml` — not created by
convention at runtime, so read-only is enforced by the server rather than by
discipline in the query layer:

| User | Access | Purpose |
|------|--------|---------|
| `obstack_ingest` | `GRANT ALL ON obstack.*` | owns the `obstack` database and its DDL |
| `obstack_web`    | `GRANT SELECT ON obstack.*`, profile `readonly=2` | the web query layer |

An `INSERT` or any DDL as `obstack_web` is rejected with `ACCESS_DENIED`.

Passwords are read from the environment (`from_env`), so the XML holds no
secrets. `docker-compose.yml` supplies dev defaults; override them by exporting
`OBSTACK_CLICKHOUSE_INGEST_PASSWORD` / `OBSTACK_CLICKHOUSE_WEB_PASSWORD` or by
putting them in a `.env` next to `docker-compose.yml`.

The image's built-in `default` user is left in place but is restricted to the
container's loopback by the upstream entrypoint, so it is unreachable through
the published ports. Use it for in-container debugging:

```bash
docker compose exec clickhouse clickhouse-client
```

Connection settings for the two callers, with the dev defaults:

```bash
# ingest, from inside the compose network
CLICKHOUSE_DSN=clickhouse://obstack_ingest:obstack_ingest_dev@clickhouse:9000/obstack

# web, from the host
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USER=obstack_web
CLICKHOUSE_PASSWORD=obstack_web_dev
```

## Schema

The `obstack` database and all of its tables are created by the ingest service at
boot from `services/ingest/migrations/`, tracked in `obstack.schema_migrations`.
Nothing here ships DDL, and there is no `docker-entrypoint-initdb.d`: the schema
only ever arrives through the ingest binary, either at boot or from the
`/ingest migrate` one-shot described below.

Pre-release, applied migrations are edited in place rather than superseded, so
after pulling a schema change run `docker compose down -v` before `up`.

### Exactly one migration runner per upgrade

There is no lock around the migrations, and there is deliberately never going to
be one. ClickHouse has no advisory locks; the only primitive that would serialise
them is a KeeperMap table, which would make ClickHouse Keeper a hard dependency
for every single-node self-hoster — a standing operational cost, paid forever,
against a race the deployment model can rule out for free. So the rule is
structural, and anything that deploys obstack has to honour it:

**Exactly one process applies migrations per upgrade.**

Compose gets that for free: one `ingest` container, `OBSTACK_MIGRATE_ON_BOOT`
unset and therefore true, applying the schema at boot as it always has. The one
way to break it here is `docker compose up --scale ingest=2` — don't.

Kubernetes cannot get it for free, because the natural chart default is two or
more replicas and every one of them would boot into the same DDL. The chart
(`deploy/helm/obstack/`, the one M4 extends in place — D35) splits the two
roles instead. The Job's lifecycle differs by operation —
install: normal Job; upgrades: `pre-upgrade` hook — because on an install
ClickHouse does not exist yet for a hook to run against, while on an upgrade
it has been running since install (`deploy/helm/obstack/README.md` has the
full reasoning); either way exactly one Job applies the schema per revision.

| | applies the schema | serves traffic |
|---|---|---|
| what | a `Job` running `/ingest migrate` — a normal, revision-named resource on install, a `pre-upgrade` hook on upgrade | the ingest `Deployment`, any replica count |
| env | `CLICKHOUSE_DSN` only | the full ingest config, plus `OBSTACK_MIGRATE_ON_BOOT=false` |

`/ingest migrate` is a one-shot: it applies what is missing, logs the versions,
and exits 0, or exits non-zero and fails the release. It reads only
`CLICKHOUSE_DSN` — deliberately not `OBSTACK_API_KEYS` — so the migration Job
never has to mount the ingest bearer keys to satisfy a validator it does not use.

That split is enforceable by privilege, not just by convention: the check those
replicas run is strictly read-only, so the Deployment's `CLICKHOUSE_DSN` can name
a user with no DDL grant at all — `obstack_web`'s `readonly=2` profile is enough
to verify a schema — while only the Job's user can create anything.

`OBSTACK_MIGRATE_ON_BOOT=false` does **not** mean "skip migrations". Those pods
still check the schema before they bind anything and refuse to start if any
version the binary carries is unapplied:

```
schema migrations 0004_… unapplied and OBSTACK_MIGRATE_ON_BOOT is false; run `ingest migrate` first
```

A chart that forgets its Job therefore crash-loops loudly instead of serving
queries against a table missing columns. That is the same invariant boot-time
migration has always enforced — nothing serves a schema it does not recognise —
with only the question of *who applies* moved out of the serving path.

## Data

ClickHouse data lives in the named volume `obstack_clickhouse-data` and survives
`docker compose down`. To start from scratch:

```bash
docker compose down -v
```

## Version pin

`clickhouse/clickhouse-server` is pinned to the exact patch `26.3.17.110`. The
26.3 line is the current LTS and is on upstream's supported list; bump the pin
deliberately, never to a floating tag.
