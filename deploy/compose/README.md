# obstack compose bundle

The whole self-hosted stack: ClickHouse, Postgres, the ingest service, and the
web app (D251(c)) — a clean checkout of this bundle is the product a customer
installs. The demo agent app that generates traffic joins under its own
profile, same as the two SDK samples.

## Run

```bash
cd deploy/compose
docker compose up -d clickhouse
```

`docker compose ps` reports `healthy` once the server answers `SELECT 1`.

The whole default-profile stack — ClickHouse, Postgres, ingest and web — needs
one setting first (see [Secrets](#secrets--better_auth_secret) below), then
comes up with:

```bash
cd deploy/compose
cp .env.example .env   # then set OBSTACK_BETTER_AUTH_SECRET — see the file
docker compose up -d --wait
```

Ingest applies the schema at boot, so a clean checkout needs nothing else
besides the secret above: `web` refuses to start without it — everything else
in the default profile has no such requirement, and without it `docker
compose up -d --wait` never reports `web` healthy while the other three settle
normally. Once it does, open <http://localhost:3000>. To also generate
traffic, add the demo agent:

```bash
cd deploy/compose
docker compose --profile demo up -d --build
```

See [Smoke test](#smoke-test--the-phase-1-exit-criterion) below to prove the
pipeline works.

## Secrets — `BETTER_AUTH_SECRET`

`web` is the one service in this file with a required setting: the key that
signs session cookies. There is deliberately no default value in
`docker-compose.yml` — a cookie-signing secret shipped inside a distributable
bundle is a vulnerability every install would share (D265(a2)). Set it before
`docker compose up`:

```bash
export OBSTACK_BETTER_AUTH_SECRET=$(openssl rand -base64 32)
```

or put it in `deploy/compose/.env` (`cp .env.example .env`, then fill it in). Left
unset or empty, `web` starts, notices, prints an `openssl` one-liner to generate it (naming the in-container
`BETTER_AUTH_SECRET`), and exits 1 — loudly, not a hang and not a silent 500 (the boot check
shared with the mode-stamp refusal, `apps/web/src/server/mode-stamp.ts`). The
service carries `restart: unless-stopped` like every other one here, so what
you SEE is a container that never reaches healthy and keeps coming back —
D273: the restart loop is the operator symptom. The refusal itself — the sentence naming the variable and the `openssl` line — is
what `docker compose logs web` prints. Nothing else in this file reads it:
ClickHouse, Postgres, ingest, the demo agent and both SDK samples have no auth
of their own to sign.

`BETTER_AUTH_URL` (also `.env.example`) is optional and defaults to
`http://localhost:3000`, the origin this bundle serves over. Point it at a
real `https://` origin the moment this sits behind TLS — that is what
upgrades the session cookie to the `__Secure-` name better-auth issues over a
secure origin; left at the http:// default, the cookie stays at its
downgraded name (D119), the correct tradeoff for a loopback-only install and
the wrong one past it.

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
It is also the `e2e` job's pipeline floor (D136 — the middle of the three lines
below in "The e2e drive"): if a trace cannot land whole, every tenancy claim made
after it is a claim about a store nothing can write to. The assertable half of
that is one command, run from the repo root:

```bash
bash deploy/compose/smoke.sh
```

It boots the stack (`--profile demo`, `--build`, naming `demo` on the `up` line
rather than the default profile — `demo`'s own `depends_on` chain brings
ClickHouse, Postgres and ingest up with it, and web is not this harness's claim
(D265(a1)): it asserts through the module below, never through a served page),
waits for every container to report healthy, fires
`POST localhost:8000/chat` at the demo agent, and then asserts through the web
facade — `smoke.ts` calls `searchTraces()` and `getTrace()`
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
the notification bell's unread count is still demo content; the account menu
names the signed-in operator and opens `/app/account`, their own name, address,
password and sessions (D707).

## The e2e drive — two strangers, two workspaces (the S3.1 criterion)

`smoke.sh` proves one trace lands whole. This run proves who is allowed to see
it. Two strangers sign up through the real form, each lands in the organization
and workspace their own signup created, each gets telemetry seeded for exactly
the workspace id the product rendered for them, and neither ever sees the
other's rows. It is the ratified stranger protocol (U9) as an executable, and
the same three lines CI's `e2e` job runs (S2.1 L3), from the repo root:

```bash
docker compose -f deploy/compose/docker-compose.yml up -d --wait --wait-timeout 240 clickhouse postgres ingest
bash deploy/compose/smoke.sh
node deploy/compose/e2e-drive.mjs
```

The stack goes up first because the drive signs strangers up, and ingest binds
`/healthz` only once both migration sets are applied — so `--wait` is what makes
"the schema these accounts land in exists" a fact rather than a hope, and the
timeout is what makes a wedged stack say so instead of waiting forever. Booting
it in its own line rather than leaving it to `smoke.sh` (which would also bring
it up) is what makes a wedged boot report as a boot failure. Naming
`clickhouse postgres ingest` rather than the default profile (D271): web is
not this harness's claim (D265(a1)) — the drive below builds and serves the
production app itself rather than talking to the containerized `web`, so
naming it here would both build its image and start the container for a
process nothing in this run ever reaches. The `images` job and a self-hosted
install are what actually boot it.

`smoke.sh` — the Phase 1 exit criterion above — is this run's **regression
floor**, and it comes second on purpose: if the ingest pipeline cannot land a
trace whole, every tenancy claim after it would be made about a store nothing
can write to, so the floor is what should go red. It leaves the demo agent
running and real telemetry in `ws_demo` — a third tenant neither stranger may
see, which the drive's per-workspace denominators are indifferent to.

The drive
then builds the production app itself, serves it at `http://localhost:3210`
(**localhost**, never `127.0.0.1` — that origin is what makes the production
`__Secure-` session cookie the one the product actually issues, D119), and
drives one throwaway Chrome profile per stranger over CDP. It prints one
`ok`/`FAIL` line per claim, exits non-zero on any failure, and leaves its
artifacts — build log, server log, both seed outputs, the metrics seed output,
both metrics-checks outputs, the transcript — in a temp directory it names
(override with `OUT_DIR=...`).

What it asserts, in order:

- **signup is real tenancy** — each stranger lands in the app on exactly one
  cookie, the production session cookie, and the shell's workspace line shows an
  id that belongs to them; a workspace nobody has sent telemetry to renders as
  honestly empty rather than seeded with anything;
- **the wired surfaces, against a counted denominator** — the seeded workspace is
  counted *in ClickHouse* (`exit-seed.mjs`, 220 traces, deliberately more than
  the 200-row page, and 245 log rows, more than the 200-row cap; every sixth
  trace carries a `gateway → agent → tool` chain, two residues of the roots
  carry an `enduser.id`, and the roots that fail carry one of two error
  messages — one with digits that differ per trace, one with none — so the
  surfaces wired in S6.2 have real topology, real people and real error groups
  to render), so every
  "N of M" the UI prints is checked against a number the app did not compute:
  totals, a real page 2 disjoint from page 1, the free-text legs, the logs cap's
  truncation marker, the D42 carrier row, the real empty states, and the
  adversarial URL matrix (D66/D68/D73) answering 200 with default bounds;
- **the browser half** — a URL that moves underneath a filter bar (pager, back,
  forward, deep link) is adopted into the controls on both surfaces (D69), a
  late echo of an earlier keystroke does not rewind text typed since (D72), and
  a saved view survives a reload and applies. Saved views are workspace-scoped
  Postgres rows now (D30/D116), not this browser's storage: the second stranger's
  menu does not list the first one's view;
- **strict disjointness, by count and by content** — one stranger's list is
  honestly empty while ClickHouse holds 220 traces for the other; once both are
  seeded, each list totals its own 220 rather than the 440 summary rows the store
  holds, and a free-text search still reaches exactly one trace though the token
  now exists in both workspaces. Each stranger's rows are also seeded with their
  own **content label** — a word woven into the text their surfaces render — so
  the steady-state claims read what a page *says*: each tenant's list, logs and
  trace detail carry their own label and zero of the other's, and the product's
  own search finds the other tenant's vocabulary nowhere while finding the
  asker's everywhere;
- **the negative probe** — a stranger asking for a trace id that is live in the
  other workspace gets the same nothing an id that never existed gives (404,
  none of the other tenant's content on the page), and once that stranger holds
  the id himself the same URL renders *his* trace, in his words;
- **the settings surface** — one stranger reads her own org's real name off
  General, issues a key that is shown exactly once (the list afterwards carries
  its prefix and never the token, and Postgres holds only its hash), and invites
  the other with a link **copied out of the page** and accepted as the store's
  own invitation row. Accepting is additive, never a re-home: after the join the
  disjointness claims are re-asserted whole, and the newcomer's own settings
  still name his own org and workspace. The key is then revoked, its row stamped
  and the list saying so about *that* prefix — read as a date, because the tab's
  standing copy mentions revoked keys whether or not anything is revoked;
- **the quickstart, and attribution (D115)** — the same stranger opens
  `/app/onboarding`, presses *Issue a key* there, and the drive takes the token
  **off the rendered snippet** — the only place it exists, since a stored token
  is unrecoverable (D98) — and sends a real three-span trace with it to the
  compose stack's OTLP endpoint. That trace must land in *her* workspace, in no
  other workspace at all (asked once with her id and once without), and be
  reachable by the words it says through the product's own search while the
  other stranger's search for the same vocabulary finds nothing. Her waiting
  panel must then flip **on its own poll** — bounded by one metering flush plus
  one 5s client poll, a failure past it rather than a longer wait — to a link
  whose trace id is the id the drive sent, not merely the newest row in her
  store;
- **connections shows that key** — `/app/connections` lists the key events
  actually arrived on (the settings key, which nothing was ever sent on, is a
  credential and is *not* listed), with the D100 counters as they are: cumulative
  totals with the instant they were counted at, errors that are receive-path or cardinality-cap drops
  and quota drops rendered as sampling rather than as faults (D218/D219), and no
  invented per-minute rate anywhere on the panel. `/app/connections` is live-wired
  and carries no `SAMPLE DATA` badge, while `/app/ask` still does;
- **Explain, run and refused** — she opens one of her own failed traces, presses
  *Explain this trace*, and the panel streams the **fake engine's** answer: the
  engine with the provider taken out (D168), which is the only one CI ever runs
  because CI never spends (U6). The answer must be about *that* trace — the
  failing span's own name and service — must say plainly that no model read it,
  and must link the evidence it cites; the counter line under it divides the
  plan's own two numbers, never a hardcoded twenty (D163/D226). A second run,
  made as the panel makes it, is read as the NDJSON frame (D227): deltas, then
  exactly one terminal event, and every span id in its evidence is checked
  against the span ids ClickHouse holds for that trace (D223) — two runs of one
  trace, one answer. Then the refusal is walked **on purpose**: the free plan's
  Explain allowance is lowered to two the way the event quota is lowered
  (D172 class), so the third run is refused as a *product outcome* — a 200
  carrying a terminal `refusal`, a sentence a person can act on, and nothing
  spent (D225/D241). The panel's counter, the settings meter and the row the
  route's statement guards are then the same two numbers. The step runs inside
  the metering propagation wait on purpose (D207): that sleep is computed from an
  absolute deadline, so work done first costs the run nothing;
- **alice's metrics land through the FRONT DOOR, and the query contract answers
  for them (D370)** — a gauge, a cumulative sum and a cumulative histogram are
  exported over OTLP/JSON to the real `/v1/metrics` with alice's own key, never
  a direct ClickHouse insert. `metrics-checks.ts` then asks the frozen contract
  the app itself answers with, and every claim it returns is re-stated in the
  transcript: the catalog DISCOVERS each metric by its (name, type), with the
  unit and attribute keys the export carried; the series comes back as 60
  one-minute buckets over the last hour, totalGroups one (D381); the exact
  expected value lands in the one bucket the export stamped, and every other
  bucket reads null rather than 0; grouped by `service.name` it collapses to
  the ONE group the export's resource named. Asked with alice's expectations,
  bob's own catalog lists none of them — discovery is per tenant here too
  (D142). Then `/app/explore` renders the metric that arrived, the `<h1>`
  naming it and no `SAMPLE DATA` badge on the page, the D21 flip this sprint
  wires, while `/app/ask` — the unwired positive control the badge check
  above uses — still carries one;
- **alice's cluster goes in the same front door, and `/app/infra` renders it
  (D459/D467)** — the k8s leg exports the kubelet_stats/k8s_cluster fixture —
  two nodes, five pods, one already stale — to the real `/v1/metrics`
  immediately after the metrics leg (freshness: `INFRA_STALE_MINUTES` is 10 and
  the fixture stamps three minutes back, so the page is opened within the
  window, not after the S6.2 legs). `/app/infra` then renders her nodes and
  every fresh pod with no `SAMPLE DATA` badge — the header counting what the
  export said, each pod drilling to its own logs filter, the crash-looping pod
  carrying its real restarts and phase, the kubelet-only pod's cluster-leg
  cells marked `—` rather than guessed (D13), the stale pod ABSENT rather than
  "running", and the right-sizing panel stating the oversized limit as a
  measurement — peak, limit, window, no price anywhere (D458/D362). The other
  stranger's infra page says no cluster metrics have arrived and renders no
  table at all;
- **`/app/costs` is her own spend, and the fenced figures are absent (D461/D362)**
  — the total is the one priced call the seed sent, named by its model; the
  call no price table has a row for is counted and named as unpriced, never
  folded in as free (bob's page, read in the window before his seed, states
  that no LLM call has been traced rather than a `$0.00` he never spent); and
  no customer, revenue, margin, infra dollars or billing connection appears —
  not zeroed or marked, not on the page;
- **the five surfaces S6.2 wired, on that same seed (D21/D405)** — `/app/map`
  draws the services her spans name and exactly the cross-service hops the
  fixture chains, an edge existing only where both spans are stored;
  `/app/services` catalogs those services from the traces themselves and one
  service's page scores it from its own spans, naming them in her words, with
  the one panel it cannot derive — deploy tracking — *marked* rather than
  hidden (D362); `/app/users` names the two people her root spans carried an
  `enduser.id` for and marks the one whose requests absorbed every failure;
  `/app/issues` titles her failures with her own error messages and folds the
  seven timeouts — each stamped with a different number of ms — into ONE group
  beside the digit-free one, which is the normalization rule as an observable
  result (D399); and `/app/traces/diff` compares two of her seeded traces by id,
  while that same page, asked by the other stranger about the one trace only she
  holds, says *trace not found in this workspace*. None of the five carries a
  `SAMPLE DATA` badge or a cap banner at this scale, none renders its empty
  state, and the D142 idiom runs over all five in his browser — his own words on
  every one of them and zero of hers — with the reverse asserted on the two that
  name people and services;
- **dashboards, the one fixture with no front door (D424/D425/D427)** — a
  dashboard is a row somebody creates in the UI, so `--leg dashboards` writes it
  straight into the disposable Postgres: one dashboard for alice, four widgets,
  one per kind, all four over the metrics the leg above exported. `/app/dashboards`
  then names it with no `SAMPLE DATA` badge, and the dashboard's own page renders
  all four kinds by their titles with the fold named on each — the stat folds the
  gauge to the 42 the export sent, *as of* the minute it was stamped, and the
  top-n and table fold the cumulative sum to its 60 in the one group the export's
  resource named. `/app`'s watch slot is asserted **inside its own
  `data-tour="watches"` slice**, never over the page (the page carries SAMPLE
  chips of its own above it): it says *pinned from your dashboards · 1*, renders
  that one pinned widget and none of the three she did not pin, and claims no
  sample content. The other stranger gets the same three URLs empty in the ruled
  words — *no dashboards yet*, *no dashboard with this id in your workspace* for
  her id (never her row, never a 500), *nothing pinned to the overview yet* — and
  none of her words on any of them. Finally the accepted counter over both
  strangers' keys is read before the leg and after it and must not have moved:
  the leg touches Postgres and nothing else;
- **alerts, evaluated and delivered for real (S7.1, D477–D492)** — channels and
  rules are UI rows like dashboards, so `--leg alerts` seeds them straight into
  the disposable Postgres: two channels (one targeting the drive's own webhook
  receiver on the host, one an RFC 2606 `.invalid` host no resolver answers)
  and two rules over the same condition — the gauge the metrics leg exported,
  `avg > 40 over 15m`, a crossing by construction on its value of 42. What is
  NOT seeded is the point: the ingest binary's own evaluator claims the rules
  on its 60s tick, reads the metric through the store, fires both, and the 5s
  deliverer POSTs one and burns three attempts on the other. The drive settles
  against observed state (never elapsed time) until `/app/alerts` states both
  delivery truths — *delivered* and *delivery failed* — and the receiver holds
  the versioned payload (`version: 1`, the rule by name at `critical`, alice's
  workspace). The page carries no `SAMPLE DATA` badge (the flip), targets
  render masked (`/...hook`, never the URL the seed handed over), the live rule
  shows *firing*, and the other stranger's `/app/alerts` is the empty state
  with none of her rules, channels or words. Compose sets
  `OBSTACK_NOTIFIER_ALLOW_PRIVATE` for exactly this receiver (D492) — the
  production default stays strict, refusals dial-time-proven in Go tests;
- **changes, posted by the documented step itself (S7.2, D493–D504)** — the
  drive lifts the `run:` block out of the docs page
  (`connectors/github-actions`, between its recipe markers), makes the ONE
  edit the page tells a reader to make (`service` → the trace leg's own
  service name, asserted to be exactly one substitution) and runs it under
  `bash` with `OBSTACK_INGEST_URL`/`OBSTACK_API_KEY` (the quickstart's key,
  in the child's environment and nowhere it prints) and the `GITHUB_*`
  context — real on the Actions runner, stood in for locally. The step is
  answered `201` with a row id; run again it is answered `200 deduplicated`
  with the ORIGINAL id (the retry a re-attempted job makes, D496); a flag
  event posted directly lands too, a `javascript:` href is refused naming
  `link.href`, a keyless post is `401`. `/app/changes` then renders both
  events newest-first with their `via` labels, the deploy's link as an
  EXTERNAL anchor to the workflow run, no `SAMPLE DATA` badge and no `INC-42`
  story; the service's own page names the deploy's ref and actor in the panel
  that carried a sample mark until this sprint (D362 released by D503); and
  the other stranger's `/app/changes` is the empty state with none of her
  words. `RED_WITHHOLD_CHANGES=1` skips every post and must fail exactly the
  answer and page checks, never the leg's own preconditions;
- **slos, measured by the evaluator over alice's own traces (S7.3, D505–D518)** —
  objectives are UI rows like rules, so `--leg slos` seeds them straight into
  the disposable Postgres: for alice a channel targeting the drive's own
  receiver plus two objectives — availability at 99.99% over 7d on that
  channel (the seeded dataset fails one trace in twenty, so BREACHED by
  construction) and latency at 50% under ten minutes over 30d with NO channel
  (HEALTHY, silent); for the other stranger one objective scoped to a service
  his traces never name (NO DATA on a workspace that has traces — an empty
  window is a state, never a measured 100%). What is NOT seeded is the point: the ingest binary's evaluator
  claims them on its 60s tick, merges `trace_summaries` for the window
  (traces good = no error span, the D505 definition), writes attainment,
  budget and status, and the S7.1 deliverer POSTs the breach. The drive
  recomputes good/total over `trace_summaries` with its OWN SQL and asserts
  the card's percentage and its "N of M traces good" against that (D71(b));
  the budget number is stated unclamped while the bar is clamped at 100%; the
  objective sentence is the formatter's exact output; the feed carries the
  breach by the evaluator's title, `delivered`, attributed `slo:`; the
  receiver holds `version: 1`, `rule: null`, `slo.{name,objective,status}`;
  the latency card says *no channel — computed only* and states the D507 clip
  (*30d · 7d retained on Free*) with no event in the feed; the inspect links
  are the real traces list filtered the way the objective is defined; and the
  other stranger's `/app/slos` lists only his NO DATA card with a dash for the
  number and none of her words. `RED_WITHHOLD_SLOS=1` seeds the channel and
  withholds every objective and must fail exactly the slos-arm checks, never
  the seeder's status;
- **incidents, through the front door, on the one Explain counter (S7.4,
  D559–D566)** — no seeder leg: CRUD and promotion are the sprint's
  deliverable, so alice's two incidents and the other stranger's one go in
  through the real forms. A HISTORICAL incident is declared with an explicit
  start over the seeded fixture's own failing roots and resolved with an
  explicit end — the window cut from the store's error spans so that both
  bounds are proven to bite, whole seconds so the instants round-trip exactly
  — and its trace leg is checked against the drive's OWN SQL over
  `obstack.spans` (§3's grouping restated, `argMin` included), the instants
  bound through `extract(epoch …)` and never parsed in JS (D71(b)/D562): every
  `(service, span)` group drawn at its first_seen with its count, its span and
  its example trace, zero alert or change rows, one resolved row, the
  changes-leg-empty sentence with its recipe link, no omission and no clip. An
  ONGOING incident is PROMOTED from the oldest alert event the evaluator wrote,
  so its rail carries every alert event and both change events from two
  Postgres tables, anchored by their ids in the order of their instants, the
  deploy as an EXTERNAL anchor to the workflow run — and no trace row, with the
  store asked and agreeing that no error span starts inside that window
  (D561). The list derives its header from the read; the other stranger's list
  holds only his incident, her id answers him with the one not-found sentence,
  and his POST to her RCA route is a 404. Then the Explain collision (D563):
  alice spent both runs on traces ~1400 lines earlier, so her RCA is refused
  with the sentence EXTRACTED from the trace panel's own text — one allowance,
  two subjects — and moves nothing, while the other stranger's RCA on his own
  incident is answered about its timeline (the fake's headline naming the group
  the recomputation puts first, the tally over exactly the stored window, every
  cited example trace one the recomputation named) and moves HIS
  `explain_runs` row alone. `EVIDENCE_EXPLAIN_QUOTA` stays at 2 and no earlier
  assertion moves. `RED_WITHHOLD_INCIDENTS=1` withholds the whole interaction
  block — both create submits, the promote click and both RCA presses — and
  must fail exactly the arm's checks, never its preconditions and never a
  `must()`; the arm's wall time is printed so the ~6-minute line is measured,
  not assumed. The unauthenticated probe below gains the two incident routes
  and reclaims the four the list had silently missed (`/app/costs`,
  `/app/infra`, `/app/changes`, `/app/slos`), and now reads
  `live-routes.ts` as text and asserts every registry entry is probed
  (D565). And the plans catalog drift is closed: the drive reads
  `plans.event_quota`/`explain_quota` for `free` before it lowers them and
  restores both in `finally`, before the pool ends, from the values it
  captured — never from a number spelled in the file — so
  `usage.integration.test.ts` and `explain/quota.integration.test.ts` run
  green on a driven stack (D566);
- **token hygiene** — both keys the run issued through the UI are searched for,
  as literals, in everything the drive printed and everything it wrote: stdout,
  the transcript, the server log, the build log, every artifact beside them. The
  only place a live key is allowed to appear is the `Authorization` header it was
  sent in — a drive that proved attribution by printing the token would have
  published a working credential into the CI log. (Chrome's own profile
  directories are deliberately not searched: a browser caching a page it was
  shown is the browser, not this drive's artifact.) The sweep covers Explain
  credentials too: the app is served with `ANTHROPIC_API_KEY` and
  `OBSTACK_EXPLAIN_API_KEY` removed from its environment — fake mode
  authenticates nothing, so the measured server holds no key at all — and
  whichever of the two the caller's own shell held is searched for as a literal
  beside the issued tokens. The drive refuses outright if `OBSTACK_EXPLAIN_MODE`
  names anything but the fake;
- **sign-out and no session** — the one cookie goes, every wired route answers a
  cookie-less browser with `/login` and no telemetry, and the quickstart's poll
  route (`/app/onboarding/status`) answers a bare `401` with no body and no
  redirect, because a poll is not a navigation (D216).

Properties worth knowing before changing it:

- **It only measures processes it started itself.** If anything already answers
  on the app port (`APP_PORT`, 3210) or either CDP port (`CDP_PORT_A` 9333,
  `CDP_PORT_B` 9334) the run refuses and exits non-zero, instead of asserting
  against a leftover server from an earlier run — which serves an *older build* —
  or a browser carrying somebody else's cookies, which in a drive about whose
  data you can see is not a detail. Each stranger gets their own throwaway
  `--user-data-dir`: two actors sharing a cookie jar are one actor. It kills its
  own server and browsers on the way out, `npm exec` child included.
- **It builds with the same environment it serves with.** The app layout decides
  the `SAMPLE DATA` badge from the data mode, and a statically prerendered route
  bakes that decision at *build* time — so a mock-mode build served in live mode
  ships unwired pages with no badge at all. Any deployment has the same
  property: build in the mode you will serve.
- **The badge check carries a positive control**, an unwired route that must
  still show the badge. Without it, "no badge on `/app/traces`" would also pass
  if the badge had been deleted everywhere.
- **The attribution step runs before the quota comes down, and its events are
  counted.** Past that line every export is a candidate for sampling, and a first
  trace that survived one run in ten would make the panel's flip a coin toss; so
  the three spans are sent while the workspace is under quota. They are three
  metered events all the same, and the metering arithmetic below them says so
  (`EXPECTED_ACCEPTED` = the attribution trace plus what the metering key sent) —
  the ledger and the Data & ingest tab are per *workspace* and hold both keys,
  while the per-key health row holds only its own.
- **The negative probe is ordered, not id-distinct.** `exit-seed.mjs` is the one
  seeding definition and its ids are deliberately label-independent, so both
  workspaces end up holding the *same* trace ids. The probe therefore runs before
  the second workspace is seeded — the id is live in ClickHouse under the other
  workspace, and the asker still gets nothing — and the very same URL is then
  re-run after seeding as a positive control, where it renders. The pair is what
  makes the 404 a fact about tenancy rather than about a route that never works.
  What the labels then add is the case counting cannot see: with the same ids in
  both workspaces, a merge can leave every total exactly where it was, and only
  the words give it away.

The dataset is designed so the free-text legs are falsifiable end to end: one
token exists *only* inside a span's `prompt` column, another *only* inside a log
row's `body`, and a third *only* on a D42 content-carrier row (empty body). The
first two must be findable from the traces list; the third must be findable
there too and must be invisible to `/app/logs`, which searches bodies only
(D51(e)). Both arguments the seeder takes are required and neither has a
default — the workspace, and the content label woven into that seeding's words:

```bash
node deploy/compose/exit-seed.mjs --workspace ws_1a2b3c --label zzalice
```

The metrics leg (D370) is separate and additive, and its key is a live
`ok_live_` token: a token in argv sits in every process listing on the box, so
it goes in the environment instead and never on the command line — and the
drive's own hygiene sweep then asserts it reached nothing that run printed or
wrote. The leg POSTs to ingest's real OTLP front door and touches ClickHouse
for nothing:

```bash
SEED_METRICS_TOKEN=ok_live_… INGEST_OTLP=http://127.0.0.1:4318 \
  node deploy/compose/exit-seed.mjs --workspace ws_1a2b3c --label zzalice --leg metrics
```

The dashboards leg (D424) is separate and additive too, and it is the only
direct-SQL seed in this file: a dashboard is a row somebody creates in the UI,
and no exporter, endpoint or API can put one there, so there is no front door to
prefer. It writes ONE row into the disposable Postgres with the app's own shape
(`dash_`/`wdg_` ids, `widgets` exactly `lib/dashboard-types.ts`'s
`DashboardWidget[]`), and it must run AFTER the metrics leg — every widget names
one of the metrics that export sent:

```bash
node deploy/compose/exit-seed.mjs --workspace ws_1a2b3c --label zzalice --leg dashboards
```

A second run into the same workspace is refused by `UNIQUE (workspace_id, name)`
rather than by a guard this file could write.

The k8s leg (D467) is separate and additive too, and it goes through the same
front door as the metrics leg — the real `/v1/metrics`, the token in the
environment and never in argv. It sends the S6.4 kubelet_stats/k8s_cluster
fixture: two nodes and five pods whose names, header line and ratios the leg
prints as its own expectations (the drive reads them from there, never spelled
twice) — a crash-looping pod, a kubelet-only pod with no cluster leg, a pod
whose memory limit is measurably oversized, and one pod stamped stale on
purpose. It takes no `--label`, because nothing it sends is content — metric
names and pod names are identifiers, and the filter legs match identifiers
exactly:

```bash
SEED_METRICS_TOKEN=ok_live_… INGEST_OTLP=http://127.0.0.1:4318 \
  node deploy/compose/exit-seed.mjs --workspace ws_1a2b3c --leg k8s
```

Like the metrics leg it has no double-run guard, and the same caveat applies:
a second run by hand re-stamps the fixture's timestamps, so the freshness
claims the drive makes (the stale pod absent, everything else inside
`INFRA_STALE_MINUTES`) stop describing what the store holds.

The label goes on content only — names, bodies, prompts — and never on an
identifier, because the filter legs match services and pods exactly; and never
on an empty field, because the carrier row's empty body is the leg.

The seeder refuses to run twice into a non-empty workspace — the trace/log leg
only. It cannot delete — the ingest user has no mutation grant — so a second
run would duplicate every row and silently inflate the counts the drive
checks. The metrics leg has no such guard: a second run by hand carries a new
start time, so ingest reads it as a stream restart (D363 §1's reset rule)
rather than a continuation of the series already there, and the expectations
that run prints — the sum's 60 among them — stop describing what the store
holds. Each run signs up new strangers, so it seeds workspaces nobody has
seeded before; `docker compose --profile '*' down -v` is how you start the
whole thing from nothing.

A driven stack IS a stack the test suites can run against (S7.4, D566): the
drive lowers two columns of the free plan for its own proofs — the event quota
(`exit-seed.mjs --lower-free-quota`) and, for the Explain step, `explain_quota`
— and puts both back in its `finally` block from the values it read before it
wrote, so the plans-catalog assertions in `apps/web`'s suite
(`usage.integration.test.ts`, `explain/quota.integration.test.ts`) pass after a
drive; the restore is itself a check in the run's transcript. The one residue is
a run killed before `finally` could reach the pool (or a volume driven before
S7.4): then the catalog still reads `300`/`2`, and `down -v` is the way back.

### The captured-DDL drift check

better-auth's tables are **captured**, never migrated by the library:
`services/ingest/pgmigrations/0003_auth.sql` is the verbatim output of the
generate path run against `authConfig()` (`apps/web/src/server/auth.ts`), and
nothing in the library re-checks that pair. This is the question that keeps them
one definition — it regenerates the DDL from the config the app runs and diffs
it against the checked-in file, failing on any difference and naming both sides
and the re-capture recipe. It is a standing `e2e` step (D122; it moved out of
`stack` in S4.3 — D298/D306(d) — because its failure source is app code ordinary
web PRs touch, and `stack` no longer gates a merge, so a guard left there would
first go red only after the merge). The same line by hand, from the repo root
against a running compose stack:

```bash
BETTER_AUTH_SECRET=ddl-drift-check-dummy-secret-not-a-real-one \
  npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
  deploy/compose/ddl-drift-check.mts
```

The secret is required by `authConfig()` and plays no part in the schema, so it
is a disposable literal. `BETTER_AUTH_URL` is set nowhere in this repo, and that
is D119 rather than an omission. The generator emits only what its target
database is missing, so the check creates and drops a scratch database on the
compose Postgres — it writes nothing to a database the product reads.

## SDK exit evidence — the S2.4 criterion (install + two lines, four layers)

`smoke.sh` proves the bring-your-own-OpenTelemetry path. This run proves the
other one: three sample apps whose only telemetry code is an obstack SDK install
and the documented two lines each land the same four-layer trace with the D8
GenAI attributes. One command from the repo root, and it is the same line CI's
`sdk-e2e` job runs (S2.1 L3):

```bash
bash deploy/compose/sdk-evidence.sh
```

It destroys the compose volumes first, brings up `clickhouse` + `ingest` plus
the `sdk` profile's three sample services — all built from the repository root:

| Service | Host port | What only it proves |
|---------|-----------|---------------------|
| `sdk-sample-py` | 8010 | the Python SDK's four-layer trace, and the correlated logs its root-logger handler produces (D84) |
| `sdk-sample-ts` | 8100 | obstack-js on `ai` 6, where `generateText` is opted in per call with `experimental_telemetry`, plus both instrumented `openai` surfaces — chat completions and the Responses API (D308) |
| `sdk-sample-ts-ai7` | 8110 | obstack-js on `ai` 7, where the same `generateText` call passes **no telemetry option at all**: the span is on by default, and an app carrying no obstack option landing the same four layers is the only way to show it (D307). A copy of `sdk-sample-ts` otherwise — see its `package.json` `//twin` note for the complete list of differences. |

It fires one documented request at each, and asserts, printing one `ok`/`FAIL`
line per claim: four layers under one `trace_id` with the full D8 set and a
non-zero ingest-computed cost; prompt and completion in the dedicated columns
with neither the two keys nor the content itself anywhere in the attributes Map;
no `ai.*` attribute key anywhere on the `ai` 7 trace, against the `ai` 6 trace's,
which has them, as its positive control; all three traces rendering through the
shipped query layer (`sdk-checks.ts`, the same facade `smoke.ts` uses), which
also picks the Responses-API llm span out of each TypeScript trace by its
`completed` finish reason (D301) and holds it to the same D8 set; standard OTLP
on the wire, against a stock upstream collector that has never heard of obstack;
fail-open live, each sample still answering 200 with its endpoint on a dead port;
and the D15 floor, that `demo/agent-app/` is untouched.

Like the drive above, it only measures what it started itself — it **refuses
to run** if a container of this compose project is still standing from another
profile, if anything already answers on one of the nine ports it uses, or if one
of its probe-container names is taken. Stop them first, the way the refusal
tells you to:

```bash
docker compose -f deploy/compose/docker-compose.yml --profile '*' down -v
```

The three sample services stay up after a passing run, under
`restart: unless-stopped`, so the trace can be opened in the browser. They are
harmless to the two runs above — `smoke.sh` asserts on the `trace_id` the demo
agent hands back, and the e2e drive counts the workspaces its own strangers just
created — but `--profile demo down -v` does not remove them, so use the
`--profile '*'` line above when you want the project genuinely empty.

Ports, published on `127.0.0.1` only — the dev passwords below live in this
repo, so nothing is exposed to the network; services inside compose reach the
server as `clickhouse:9000` instead:

| Port | Protocol | Used by |
|------|----------|---------|
| 8123 | HTTP     | the web app (`@clickhouse/client`), run from the host |
| 9000 | native   | `clickhouse-client` from the host (ingest uses the compose network) |
| 5432 | Postgres | the web app (`pg`) and `psql` from the host (ingest uses the compose network) |

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

## Postgres — identity and saved views

The stack's other store (D95/D112). ClickHouse holds telemetry; Postgres holds
who you are, what you saved, and what may write: `workspaces`, the captured
better-auth tables, `saved_views`, and `api_keys` ([API keys](#api-keys--postgres-rows-and-the-dev-key)
below). It runs in the **default** profile — a plain
`docker compose up -d` starts it, like ClickHouse — pinned to the exact patch
`postgres:17.11`, with its data in the named volume `obstack_postgres-data`.

One user, one database, both named `obstack`; the dev password is
`obstack_postgres_dev`. `POSTGRES_PASSWORD` is read by the image's entrypoint at
**initdb time only**, so overriding `OBSTACK_POSTGRES_PASSWORD` against an
existing volume rotates nothing and only breaks the DSNs below — change it from
`down -v`, not on a live volume.

```bash
# ingest, from inside the compose network
OBSTACK_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@postgres:5432/obstack

# web, from the host (the same variable name — D112: one env name per value,
# every tree)
OBSTACK_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack

# psql, from the host
psql postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack
```

`BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are deliberately **not** on this
service (D112(b) — a cookie-signing secret belongs to the process that signs
cookies, which has never been Postgres). They are `web`'s, set from the one
operator value `OBSTACK_BETTER_AUTH_SECRET`: see
[Secrets](#secrets--better_auth_secret) above.

## API keys — Postgres rows, and the dev key

An API key is what a client sends as `Authorization: Bearer <token>`, and it
names the workspace every record in that request is written into. Keys are rows
in Postgres `api_keys` (D98), issued in the product's settings surface; ingest
resolves a token by looking up the SHA-256 of the exact string it received.
There is no key variable to set on the ingest container — the ingest
environment in `docker-compose.yml` carries the two DSNs and nothing else.

Only the hash is stored, so a key is shown once at issue time and is not
recoverable from the database afterwards. Ingest caches lookups for 30 seconds,
positive and negative, which is also how long a revoked key can keep working.

The dev key every harness and sample in this repo uses, `ok_dev_local`, is a
row like any other: `services/ingest/pgmigrations/0004_api_keys.sql` seeds it
against workspace `ws_demo` when the Postgres set is applied. It is a public
credential by design — it is printed in this repository — so the demo, the two
SDK samples and the collector all default to it and a clean `up -d --wait`
authenticates with no setup. Override it per container with
`OBSTACK_DEMO_API_KEY` / `OBSTACK_SDK_API_KEY` / `OBSTACK_COLLECTOR_API_KEY` to
send under a key you issued instead.

```bash
psql postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
  -c "SELECT id, workspace_id, prefix, revoked_at FROM api_keys"
```

Ingest's per-workspace metric series on `:8080/metrics` are created on the
first event for that workspace, so a series that is missing means nothing has
arrived under that key yet, not that the pipeline is broken.

## Schema

Two stores, two tracked migration sets, one binary that owns both. Nothing here
ships DDL, and there is no `docker-entrypoint-initdb.d` on either database: the
schema only ever arrives through the ingest binary, at boot or from the one-shot
subcommands described below.

| Store | Migration set | Tracked in | Applied by |
|---|---|---|---|
| ClickHouse | `services/ingest/migrations/` | `obstack.schema_migrations` | boot (`OBSTACK_MIGRATE_ON_BOOT`, default true) or `/ingest migrate` |
| Postgres | `services/ingest/pgmigrations/` | `schema_migrations` in the `obstack` database | boot (`OBSTACK_PG_MIGRATE_ON_BOOT`, default true) or `/ingest pg-migrate` |

The two tables share a name and collide with nothing — they are in different
databases on different servers, and the runner's log lines name the store they
are talking about.

Pre-release, applied migrations are edited in place rather than superseded, so
after pulling a schema change run `docker compose down -v` before `up`. That
clears both volumes.

### Exactly one migration runner per upgrade

There is no lock around the migrations, and there is deliberately never going to
be one. ClickHouse has no advisory locks; the only primitive that would serialise
them is a KeeperMap table, which would make ClickHouse Keeper a hard dependency
for every single-node self-hoster — a standing operational cost, paid forever,
against a race the deployment model can rule out for free. So the rule is
structural, and anything that deploys obstack has to honour it:

**Exactly one process applies migrations per upgrade.**

It covers the Postgres set too, and there the choice is deliberate rather than
forced: Postgres *does* have advisory locks. A lock on that one set would buy a
rule the other set cannot have anyway, at the cost of two different answers to
"who may apply DDL" in one product — so the second store is governed the same
structural way as the first.

Compose gets that for free: one `ingest` container, `OBSTACK_MIGRATE_ON_BOOT`
and `OBSTACK_PG_MIGRATE_ON_BOOT` both unset and therefore true, applying both
sets at boot as it always has. The one way to break it here is
`docker compose up --scale ingest=2` — don't.

Kubernetes cannot get it for free, because the natural chart default is two or
more replicas and every one of them would boot into the same DDL. The chart
(`deploy/helm/obstack/`, the one S3.1 extended in place and M4 extends again —
D35) splits the two roles instead, once per store. Each Job's lifecycle differs
by operation — install: normal Job; upgrades: `pre-upgrade` hook — because on an
install the database does not exist yet for a hook to run against, while on an
upgrade it has been running since install (`deploy/helm/obstack/README.md` has
the full reasoning, including why the two hooks are peers rather than ordered);
either way exactly one Job applies each set per revision.

| | applies the schema | serves traffic |
|---|---|---|
| what | a `Job` running `/ingest migrate` and a second running `/ingest pg-migrate` — normal, revision-named resources on install, `pre-upgrade` hooks on upgrade | the ingest `Deployment`, any replica count |
| env | one store's credentials each: `CLICKHOUSE_DSN` only, `OBSTACK_POSTGRES_DSN` only | the full ingest config, plus `OBSTACK_MIGRATE_ON_BOOT=false` |

`/ingest migrate` is a one-shot: it applies what is missing, logs the versions,
and exits 0, or exits non-zero and fails the release. It reads only
`CLICKHOUSE_DSN` — deliberately not the Postgres DSN, and not the listen
addresses — so the migration Job never has to carry configuration it does not
use to satisfy a validator it never consults. `/ingest pg-migrate` is the same
one-shot for the other set and reads only `OBSTACK_POSTGRES_DSN`, for the same
reason: a runner carries the credentials of the one store it migrates and
nothing else.

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
`OBSTACK_PG_MIGRATE_ON_BOOT` means exactly the same thing for the Postgres set,
and `OBSTACK_POSTGRES_DSN` is required either way: `ingest run` refuses to boot
without it, because a process that cannot settle the schema question has no
business reporting healthy — and, from M3 on, because Postgres is also where the
API keys it authenticates every request against live (see
[API keys](#api-keys--postgres-rows-and-the-dev-key)).

## Data

ClickHouse data lives in the named volume `obstack_clickhouse-data`, Postgres
data in `obstack_postgres-data`, and both survive `docker compose down`. To
start from scratch:

```bash
docker compose down -v
```

## Version pins

`clickhouse/clickhouse-server` is pinned to the exact patch `26.3.17.110`. The
26.3 line is the current LTS and is on upstream's supported list.

`postgres` is pinned to the exact patch `17.11` (D112), the Debian-based image —
the same tag the Helm chart runs, so local and cluster are never two different
databases.

Bump either pin deliberately, never to a floating tag.
