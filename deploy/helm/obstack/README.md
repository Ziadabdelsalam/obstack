# obstack Helm chart

The real Helm chart M4 extends in place (D35) — not a throwaway kind
manifest and not a first draft superseded later. Installs the obstack stack
on Kubernetes: CI-grade ClickHouse and Postgres, the ingest service
(Deployment + its two migrate `Job`s), the `web` workload itself, the
`obstack-collector` DaemonSet running T1's config byte-for-byte, and a demo
app pod carrying a second, uninstrumented container.

## Scope boundary (D35) — read this before extending the chart

**In scope now (M2/S2.2, extended in place by S3.1's Postgres and S4.1's
storage/secrets):**

- CI-grade ClickHouse, both D11 users (`obstack_ingest`, `obstack_web`), as
  normal, release-managed resources.
- CI-grade Postgres (S3.1/D95), the same class of resource, holding the
  product's identity and saved views — see "Postgres in this chart" below.
- The ingest `Deployment` (`OBSTACK_MIGRATE_ON_BOOT=false`) plus a migrate
  `Job` — the split `deploy/compose/README.md:147-186` designed and this
  chart is the first real execution of. One template, two renderings: a
  normal Job on install, a `pre-upgrade` hook on upgrade — see "Why
  ClickHouse is a normal resource, and the migrate Job renders two ways"
  below. The Postgres migration set gets its own Job of exactly the same
  shape (`templates/ingest/pg-migrate-job.yaml`).
- The `obstack-collector` DaemonSet, running `deploy/collector/config.yaml`
  byte-for-byte, with the RBAC, hostPath mounts and env `config.yaml` names
  as its DaemonSet's job (`deploy/collector/README.md`, "What config.yaml
  assumes of its DaemonSet").
- A demo app pod: the instrumented `demo-agent` container (OTLP routed
  through the collector, D37.1) plus a second, uninstrumented `sidecar`
  container whose stdout is the genuine NEARBY log source (D37.2).
- Every image pinned to an exact tag (D14); the three images built from this
  repo (`ingest`, `web`, `demo-agent`) are built locally and loaded into kind
  (`imagePullPolicy: Never`, S2.0's precedent) — no registry in the path.
- **Durable storage for both databases** (D253 item 2): ClickHouse and
  Postgres are StatefulSets with PersistentVolumeClaims, replacing the
  Deployment+hostPath shape every release through 0.2.0 used — see
  "Upgrading from 0.2.0" below for the breaking-change consequence and
  "Credentials and rotation" for what moved alongside it.
- **A chart-owned Secret with an `existingSecret` override on every
  credential** (D253 item 3): both ClickHouse passwords, the Postgres
  password, the two slots T5's `web` workload fills (`BETTER_AUTH_SECRET`,
  `OBSTACK_EXPLAIN_API_KEY`), `ingest`'s optional drain secret and — since
  0.7.0 — the collector's ingest key (`collector-api-key`, the pilot packet's
  D687) — see "Credentials and rotation". No external-secrets integration
  ships here; D253 refuses it as a speculative component.
- **The `web` workload** (D253 item 1): a Deployment + ClusterIP Service
  running the live-stamped image `apps/web/Dockerfile` produces, with
  `OBSTACK_DATA_MODE=live` and its store credentials wired from the Secret
  above. `web.betterAuthUrl` is the origin a browser reaches it on — the
  D119 posture is stated at that value.
- **Optional Ingress for web and for ingest's OTLP/HTTP surface** (D253
  item 4, the D214 network-reachable endpoint): host, TLS-Secret name and
  annotation pass-through, both disabled by default. No ingress controller
  and no cert-manager ship here. Enabling ingest's also sets
  `OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT` on the web workload so the product's
  quickstart renders that address; gRPC is deliberately not exposed.
- **Resource requests/limits** (D253 item 5, widened by D283): requests AND
  limits on `ingest`, `web`, the collector DaemonSet, the events collector
  and both demo containers, conservative defaults stated at each; **requests
  only on ClickHouse and Postgres** — sizing a database's limits is a
  measurement, not a guess, and a wrong limit OOM-kills the store it was
  meant to protect. The sum of every request is a budget one node must fit —
  see "The node's CPU-request budget".
- **Managed-Postgres values** (item 6) — see "Managed Postgres" below for
  that item's stated ceiling.

**Explicitly NOT in scope (D35) — this is the rest of the same chart's job,
not a gap to silently fill:**

- HA beyond ingest's existing replica story, autoscaling, PDBs,
  NetworkPolicies, multi-replica ClickHouse, backup automation — named OUT
  by D253 as S5-informed follow-up.
- TTL tiers and docs content — unrelated surfaces, no chart involvement
  either way.
- A second chart. M4 extends this one in place; a parallel chart is drift.

## Upgrading to 0.6.0

0.6.0 adds the Kubernetes metrics leg, and it is the first **non-additive**
bump since 0.3.0. Two renames, no aliases:

- **`collector.k8sEvents.*` is now `collector.cluster.*`.** The workload it
  gates stopped being about events alone the moment it grew `k8s_cluster`, and
  a flag called "events" that decides whether node readiness, pod phase and
  container limits reach the product would be a permanent misnomer in docs and
  in product copy. There is deliberately no alias: this chart has no
  production installs to protect, and an alias is the cheapest way to make a
  rename permanent. **A values file still saying `collector.k8sEvents.enabled:
  false` will not error — Helm ignores unknown keys — it will simply have no
  effect and the collector will come up enabled.** Grep your values files.
- **The singleton's objects are renamed** `<release>-collector-events` →
  `<release>-collector-cluster` (Deployment, ConfigMap, and the
  `app.kubernetes.io/component` label). `helm upgrade` deletes the old pair
  and creates the new one; anything selecting on the old component label —
  a dashboard, a log query, an alert — needs updating.

The ClusterRole also widens, behind that same flag, to what
`k8sclusterreceiver`'s informers need at the pinned v0.158.0, and the
DaemonSet gains `get` on `nodes/stats` and `nodes/proxy` unconditionally. "The
cluster collector (events + cluster metrics)" below has the exact rule and why
`replicasets` moved from documented-absent to gated-present.

## Upgrading from 0.2.0

0.3.0 replaces the ClickHouse and Postgres Deployment+hostPath shape with
StatefulSets and PersistentVolumeClaims (D253 item 2 — the scope boundary
above named this explicitly, not a gap being silently filled). **There is no
upgrade path from a pre-0.3.0 release, and none is being built** (D270): zero
production installs of this chart exist — every standing install is a
throwaway kind cluster — so migration machinery would move data nobody is
running.

**`helm upgrade` across this boundary now refuses outright (D276) — it used
not to, and that was exactly the danger.** Measured before the guard existed
(helm v4.0.1 on kind: 0.2.0 installed, then `helm upgrade --wait --timeout
300s` to this chart): a Deployment and a StatefulSet of the same name are
different kinds, so Helm patched nothing in place and Kubernetes refused
nothing — Helm simply deleted the two Deployments, created the two
StatefulSets, and they bound **brand-new, empty PVCs**. The release reported
`Upgrade complete` in 28s with `--wait` green while both stores were empty
(`psql \dt` → "Did not find any relations"; ClickHouse → `Database obstack
does not exist`) and the un-rolled ingest pods logged insert failures against
the schema that had just vanished. The old hostPath data was still sitting on
the node with nothing reading it — a silent-green data loss, not a failure a
human would ever see coming.

**A refusal is not a migration (D276's own ruling on itself):** every chart
template that replaces a Deployment (`templates/clickhouse/statefulset.yaml`,
`templates/postgres/statefulset.yaml`) now `lookup`s the live cluster for a
same-name `Deployment` at render time and `fail`s the whole release before
Helm touches anything, naming this section. Measured again with the guard in
place, same repro: `helm upgrade` against a live 0.2.0 install now stops with
`UPGRADE FAILED: … obstack-postgres exists as a Deployment — …`, revision
stays at 1, and the running 0.2.0 Deployments are completely untouched — no
StatefulSets created, no PVCs bound, nothing deleted. `lookup` is a no-op
outside a real cluster (`helm template`, `helm lint`,
`helm upgrade --dry-run=client`, and a from-scratch `helm install`, which
never has an old Deployment to find), so none of those trip it. So the move
is still a deliberate uninstall, never an upgrade — the guard makes sure
nobody can reach the silent version of the mistake above by accident:

```bash
helm uninstall <release>
# On kind the cluster (and its hostPath dirs) is thrown away with it. On a
# real node that survives, the OLD chart's per-node directories are not a
# release resource and are not removed by helm — clean them by hand:
#   rm -rf /var/lib/obstack-clickhouse/<release> /var/lib/obstack-postgres/<release>
helm install <release> deploy/helm/obstack   # 0.3.0+, from empty PVCs
```

Nothing here is a data migration: the fresh install's migrate Jobs apply the
schema to empty, dynamically-provisioned volumes exactly as a brand-new
install always has.

## Why ClickHouse is a normal resource, and the migrate Job renders two ways

**The short version:** ClickHouse, its Service and its users ConfigMap are
ordinary, release-managed resources — `helm upgrade --set clickhouse.…`
applies, `helm uninstall` removes them, nothing is inert. The migrate `Job`
(`templates/ingest/migrate-job.yaml`) is one template that renders two
different ways depending on `.Release.IsInstall`. This is advisor ruling (c)
on the T4 chart-structure escalation, replacing an earlier design (below)
that this chart's own build empirically falsified.

**What was tried first, and why it was wrong.** PR #4's design makes the
migrate Job a Helm hook. Helm's hook model has a consequence worth stating
plainly, because it is easy to get backwards: **Helm creates every
pre-install hook resource, in `helm.sh/hook-weight` order, and waits for the
hooks to finish *before it creates any of the chart's normal (non-hook)
resources at all* — proven, not assumed, by running exactly that against a
real cluster.** A migrate Job that is a *pure* pre-install hook therefore
cannot assume a normal ClickHouse resource exists to migrate against on a
from-scratch install — it genuinely would not, yet. The fix tried first was
to make ClickHouse a pre-install hook too, ahead of the migrate Job. It
worked, but a hook resource sits outside Helm's normal release lifecycle by
design, and that cost three real things: `helm uninstall` left ClickHouse
running (hook resources are not part of the tracked release manifest); every
`clickhouse.*` value went inert after the first install (the hook event that
would re-apply it never fires again); and a password change on a live
release actively broke it (the DSN moved, the ClickHouse user's password did
not). The advisor's ruling on the escalation was neither that design nor a
return to a plain, un-hooked everything — **(c): stop asking one Job's
hook-ness to solve both the install-ordering problem and the
long-lived-resource-lifecycle problem, because they are different problems
with different correct answers.**

**Install:** the migrate Job is a normal, revision-named
(`<release>-migrate-<revision>`) resource, created in the *same* batch as
ClickHouse, ingest, the collector and the demo app — Helm enforces no
ordering between any of them here. The `wait-for-clickhouse` initContainer —
**one definition** (`obstack.waitForClickhouse`, `templates/_helpers.tpl`),
included by both the migrate Job *and* the ingest Deployment, so the poll
budget cannot drift between them — polls ClickHouse's `/ping` and holds each
pod back until ClickHouse actually answers (playing the same role compose's
`depends_on: condition: service_healthy` plays: keeping the Job's
`backoffLimit` a signal about migrate *failing* and ingest's restart count a
signal about *refusal*, neither about how long the ~250 MB ClickHouse cold
pull took). The ingest pods therefore sit in `Init:0/2` (S3.1 added the
second wait — `wait-for-postgres`) with zero restarts while ClickHouse
pulls; their verify-and-refuse boot check
(`OBSTACK_MIGRATE_ON_BOOT=false`, `templates/ingest/deployment.yaml`) is
untouched and still refuses loudly, with the exact documented error, if a
pod reaches a ClickHouse the Job has not migrated yet. **A clean install may
show ZERO refusals, and that is honest, not a gap**: the invariant is about
schema state, not ClickHouse reachability, and its proof of record is the
inverted-control probe (strip the hook annotations and the refusal
demonstrably fires — see the events probe below), not install-time churn.
`ttlSecondsAfterFinished` cleans the completed Job up — there is no
hook-delete-policy on an install, because this Job isn't a hook here.

**Upgrade:** the same template renders as a `pre-upgrade` hook instead
(revision-named, `before-hook-creation,hook-succeeded`), because on an
upgrade the ordering guarantee is both meaningful *and actually
deliverable*: ClickHouse has been running since install, so there is no
cold-start race to design around, and "migrate finishes before the upgraded
ingest replicas roll" is a real Helm hook doing real work — Helm creates and
waits for `pre-upgrade` hook Jobs before touching any of the release's
normal resources. Two consequences of values being live are handled inside
the templates and worth knowing about rather than rediscovering:

- **The hook's password source is `clickhouse.existingSecret`, not a live
  `lookup` (D275).** `obstack.migrate.clickhousePassword` (formerly
  `_helpers.tpl`) used to authenticate a password-rotating upgrade's hook
  with whatever password ClickHouse was ACTUALLY running, by `lookup`-ing the
  live `Deployment`'s env — that target stopped existing the moment
  ClickHouse became a StatefulSet (`templates/clickhouse/statefulset.yaml`),
  so the helper had already silently fallen through to
  `.Values.clickhouse.ingestPassword` on every upgrade, not just install; it
  is deleted rather than repointed at the StatefulSet, because the concern it
  existed for is better solved by `existingSecret`. The migrate Job
  (`templates/ingest/migrate-job.yaml`) now branches on
  `clickhouse.existingSecret` the same way the StatefulSet's own env does: set
  it, and the hook reads the password through `secretKeyRef` from a Secret
  Helm never renders a value for, so there is nothing for a release's
  in-flight password change to make stale. Left unset (this chart's own
  Secret, the dev/CI default), the hook still renders
  `.Values.clickhouse.ingestPassword` straight into the DSN literal, and a
  password-rotating upgrade on THAT path can still race the ClickHouse pod's
  own roll — same limitation as before, now confined to the default path;
  the workaround is unchanged (roll ClickHouse first, then `helm upgrade`).
- **The schema survives a ClickHouse pod replacement.** An upgrade that
  changes `clickhouse.image`, a password, or the users XML rolls the
  ClickHouse pod — a StatefulSet's default RollingUpdate already terminates a
  single-ordinal pod before replacing it, the same guarantee `strategy:
  Recreate` gave the Deployment this replaced. The data dir is a
  PersistentVolumeClaim (`volumeClaimTemplates`, D253 item 2) precisely so
  the schema the hook applied is still there when the replacement pod comes
  up; with an emptyDir, that same upgrade would wedge — the hook has already
  run, nothing re-migrates, and rolled ingest pods would refuse forever.

Either way, the invariant this section replaced never changed: **exactly one
process applies the schema per revision, and every serving pod only ever
verifies** (`deploy/compose/README.md`'s "Exactly one migration runner per
upgrade").

### `--wait` and `--wait-for-jobs`, precisely

- `helm install --wait` does **not** wait for a normal Job to complete, and
  the install-rendered migrate Jobs are normal Jobs — but the green is still
  trustworthy: ingest's Deployment cannot report Available until its pods
  verify **both** schemas, which cannot happen before each store's Job has
  applied its set. Add `--wait-for-jobs` if you also want Helm to block on the
  Job objects themselves; it changes nothing about correctness.
- On `helm upgrade`, the migrate Job is a hook, and Helm **always** waits
  for hook Jobs to complete before touching any normal resource —
  `--wait-for-jobs` adds nothing there. If an upgrade seems to hang before
  anything rolls, look at the hook Job's pod first (`kubectl describe job
  <release>-migrate-<new revision>`). A hook that cannot finish blocks the
  whole upgrade until `--timeout` — and so does one that has **already
  failed**: measured under Helm v4.0.1, a hook Job that hit
  `BackoffLimitExceeded` at 14:42:12 did not abort the upgrade, which sat
  until its 900s deadline and reported the failure at 14:56:57. On an upgrade
  ClickHouse is already warm, so keep that `--timeout` short (`300s` below):
  it is also how long a broken migration takes to surface.
- An upgrade cannot repair a ClickHouse that is already down — the
  pre-upgrade hook's `wait-for-clickhouse` init container blocks in front of
  the very change that would fix it. `helm upgrade --no-hooks` applies the
  normal resources without the hook — but **state the fixing value on that
  command line**: Helm v4 carries the previous release's `--set` values
  forward, so a bare `--no-hooks` re-run re-applies the very spec that broke
  ClickHouse (measured: `helm get values` still showed the bad image and the
  pod came back on it). Once ClickHouse is serving again, a normal
  `helm upgrade` runs the migration that `--no-hooks` skipped; until it does,
  the ingest pods refuse loudly with the documented error rather than serving
  an unmigrated schema.
- One `--timeout` spans both phases (hooks + resource waits). A cold
  install's cost is the ClickHouse image pull plus seconds — measured pulls
  of the ~250 MB image were 7m28s on one machine and ~11m on another, and
  everything after the pull is single-digit seconds, because the shared
  `wait-for-clickhouse` init container holds every waiting pod in `Init`
  (where no backoff clock runs) and releases it within 2s of ClickHouse
  answering. That init container is why `--wait` now tracks reality: the
  release goes green when the stack converges, not a backoff interval later.
  So the budget is the migrate Job's own `activeDeadlineSeconds`, i.e.
  `--timeout 900s` on a node that has never pulled these images — the Job
  already contains the worst case the chart allows (840s of init poll,
  sized off the slower measured pull, plus seconds of migrate), and nothing
  after the Job costs more than pod-start seconds. A warm node installs in
  ~18s.
- On a cold install expect the ingest pods to sit in `Init:0/2` (both waits)
  and each migrate Job's pod in `Init:0/1` (its own store's wait), all with
  zero restarts while the images pull — a restart on an ingest pod now means
  a schema refusal or a defect, never pull speed.
  Expect a short ClickHouse gap during any upgrade that rolls it (a
  StatefulSet's own single-ordinal RollingUpdate, terminate-then-replace):
  already-running ingest pods crash-loop through it (init
  containers gate startup only), and a rolling upgrade's *new* pods hold in
  `Init` while the old ones serve. All of it converges on its own; none of
  it needs intervention.

### The node's CPU-request budget

The budget above is time. This one is space, and it is the other way an
install can spend the whole 900s and tell you nothing useful: a pod that
cannot be **scheduled** never starts, never fails, and never times out on its
own — `helm install --wait` simply sits on it.

The arithmetic, on the smallest node this repo's CI actually schedules on. A
private-repo `ubuntu-latest` runner is 2 vCPU, so the single kind node it
creates has **2000m** allocatable, and that node's own kubeadm kube-system
pods reserve **~950m** of it before this chart exists — kube-apiserver 250m,
kube-controller-manager 200m, kube-scheduler 100m, etcd 100m, coredns 2×100m,
kindnet 100m. That leaves **~1050m** for the release.

**Measured, on PR #24's tip a541546:** the rendered chart requested **1070m**,
20m over. `obstack-clickhouse-0` — 500m, the largest single request, and
therefore the one the scheduler placed last — sat `Pending` for fifteen
minutes on `FailedScheduling: 0/1 nodes are available: 1 Insufficient cpu`,
and the `stack` job's only output was `helm install --wait` timing out at
900s. Nothing in that failure names CPU. The same install passed locally in
456s on Docker Desktop, which has more of it.

The 20m that tipped it over was the cluster-events collector, an obviously
small addition. It was fatal because the chart before it requested **exactly
1050m** — green with *zero* headroom, which is indistinguishable from green
with plenty until the next commit. So the fix is not only the arithmetic but
the slack: the chart's defaults now request **990m** (the demo agent 50m→25m
with the uninstrumented sidecar broken out to its own 5m rather than sharing
the agent's reservation, and the events collector 20m→10m — an idle API watch,
sized as one), and the budget is **1000m**, i.e. the free 1050m minus 50m kept
deliberately empty. ClickHouse, Postgres, ingest, web and the collector
DaemonSet were not touched: those are the product's defaults, and shaving a
store to fit a test runner would be sizing the product for CI.

**The guard.** `acceptance.ts budget` renders the chart and sums what the
scheduler will reserve — per pod, `max(sum of containers, max init container)`,
since init containers run before and one at a time; per workload, that times
the pods it schedules at once (a DaemonSet counts once, because the budget is
about one node) — prints the table, and exits non-zero over budget. It runs
**first** in `acceptance.sh`, before any image is built, because the answer is
already fixed at render time and costs a second to ask:

```bash
npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
  deploy/helm/obstack/acceptance.ts budget
# -> StatefulSet/obstack-clickhouse  500m × 1 = 500m … total 990m (budget 1000m)

# what a given deployment's values cost — anything after `budget` goes to
# `helm template` unchanged
… acceptance.ts budget --set collector.cluster.enabled=false     # -> 980m
```

`OBSTACK_CPU_BUDGET_M` overrides the 1000m ceiling for one run — that is how
the check is proven red (`OBSTACK_CPU_BUDGET_M=900 … budget` fails with the
same table), and how a node that genuinely has more room says so. Raising the
constant in `acceptance.ts` instead is a deliberate edit, and the comment
there carries the arithmetic to redo when the runner changes.

## Postgres in this chart

S3.1 extended this chart in place (D35 — a second chart would be drift) with
the product's other store. **Two stores, two migration sets, one binary:**
ClickHouse holds telemetry, Postgres holds identity and saved views
(`workspaces`, the captured better-auth tables, `saved_views` — D95/D112),
and the ingest image owns the DDL for both. `/ingest migrate` applies
`services/ingest/migrations/` from `CLICKHOUSE_DSN`; `/ingest pg-migrate`
applies `services/ingest/pgmigrations/` from `OBSTACK_POSTGRES_DSN`. Neither
set references the other's database — D112 bars cross-set references — so
the two are peers, not a pipeline.

`templates/postgres/statefulset.yaml` is the same class of resource as
ClickHouse's, for the same reasons and with the same caveats: one replica, a
StatefulSet's default RollingUpdate (two postmasters must never open one data
directory — the same rule the old `strategy: Recreate` stated), a PVC data
dir (D253 item 2), normal and release-managed. `POSTGRES_PASSWORD` is a
`secretKeyRef` into this chart's Secret or `postgres.existingSecret` (D253
item 3 — see "Credentials and rotation"), not a literal value.

`templates/ingest/pg-migrate-job.yaml` is the ClickHouse migrate Job's
template shape line for line — normal revision-named Job on install, a
`pre-upgrade` hook on upgrade, and a `wait-for-postgres` init container in
front of the DDL that is **one define, two includes**
(`obstack.waitForPostgres`, `templates/postgres/_helpers.tpl`, shared with the
ingest Deployment, so the poll budget cannot drift between them — the same K1
rule `obstack.waitForClickhouse` follows). Three differences are worth knowing
before changing it:

- **The two hooks are peers, and that is the ordering contract.** Both carry
  `hook-weight: "0"`. There is no dependency between them to express, and a
  lower weight on either would assert one that does not exist. The run order
  is still fully determined — Helm sorts by weight, then kind, then name, and
  runs hooks one at a time, so `<release>-migrate-<rev>` always precedes
  `<release>-pg-migrate-<rev>` — but the guarantee that matters is the
  phase's: **both** complete before Helm touches any normal resource.
- **A pg-migrate failure aborts the upgrade after the ClickHouse set has
  already applied.** That is not a half-state: both sets are idempotent and
  independent, so the fixed upgrade re-runs the first hook as a no-op and
  carries on. Nothing rolls back, and nothing needs to.
- **The DSN's password source is `postgres.existingSecret` (D275), same rule
  as the migrate Job's ClickHouse half.** Set it, and the hook reads the
  password through `secretKeyRef` instead of `.Values.postgres.password`
  literal. Unlike ClickHouse there was never a `lookup` to delete here, for a
  blunter reason: `POSTGRES_PASSWORD` is an **initdb-time** value. On a
  release whose data dir already exists, changing `postgres.password` (or
  which Secret this Job reads it from) rotates nothing on its own — it only
  changes what the migrate Job authenticates as, and that has to match
  whatever the cluster was actually created with regardless of the source.
  Rotating for real means starting from an empty data dir (`kubectl delete
  pvc data-<release>-postgres-0` and let the StatefulSet recreate it, or a
  fresh cluster) — see "Credentials and rotation" for the two-step procedure
  that keeps the running database's actual password in sync instead.

**The ingest Deployment is a Postgres client too, and it must be.** It carries
`OBSTACK_POSTGRES_DSN` and `OBSTACK_PG_MIGRATE_ON_BOOT=false`, the exact
mirror of its ClickHouse pair. Ingest resolves every API key out of Postgres
while serving — the `api_keys` rows are the one authority (D98), read through
an in-memory cache with a 30s TTL, so a revoked key stops working within that
window and a Postgres outage serves what the cache already resolved rather
than 401ing live traffic; the dev `ok_dev_local`/`ws_demo` row is seeded by
`pgmigrations/0004`, and the `OBSTACK_API_KEYS` env map is deleted, with no
second lookup path. It is also the process that owns the schema, so `ingest
run` requires the DSN and refuses to boot without it, then verifies the set and
refuses loudly if this revision's Job has not applied it. Two consequences:
`helm install --wait` gates on **both** schemas, since these pods cannot
report Available until each one checks out; and these pods wait behind a
second init container (`obstack.waitForPostgres`), because a pod that now
opens two databases at boot would otherwise crash-loop on the cold-start race
the first one was added to eliminate.

**What is deliberately not here.** Neither `BETTER_AUTH_SECRET` nor
`BETTER_AUTH_URL` belongs to this block (D112): auth secrets and the origin
they sign against belong to the process that uses them, so both live in the
`web` block — the secret through `templates/secret.yaml` and
`web.betterAuthSecret`/`web.existingSecret` (see "Credentials and rotation"),
the URL as a plain value on the web Deployment. This store holds the identity
rows, never the credentials that sign against them.

## Managed Postgres

`postgres.managed.enabled` (D253 item 6) points ingest and web at a Postgres
this chart does not run: `postgres.managed.dsn` replaces the in-chart host
half of both DSNs, and the password still resolves through the same
`postgres-password` Secret key, since a managed DSN never carries one. Ingest
folds it in itself (`config.InjectDSNPassword`); the web Deployment does it
with a `replace` of the DSN's single `@` plus Kubernetes' own `$(VAR)` env
interpolation, which is why `postgres.managed.dsn`'s contract is the stricter
of the two — exactly one `@`, no password component.

**What enabling it actually does (D284):** the in-chart Postgres is
DISABLED, not idled — the StatefulSet, both its Services and its wait init
containers stop rendering entirely — and the **pg-migrate Job retargets the
managed DSN**, so the operator's Postgres receives the schema through the
same one-runner Job every install has always used (same binary, same
pre-install/pre-upgrade hook, different target). **The Job failing IS the
reachability gate, by design:** `helm install --wait` fails loudly at
pg-migrate when the managed target is unreachable — there is deliberately no
second preflight mechanism for the same fact.

**Verified in kind against an out-of-release Postgres simulating the brought
DSN; verification against a real managed provider (TLS/`sslmode`, provider
auth) cannot exist in kind and is pre-registered to S5**, where the actual
instance arrives with the hosting decision — recorded here so it is chosen,
not discovered.

The DDL itself is asserted directly with this line, which is exactly what
CI's `stack` job runs after the acceptance (S2.1 L3) — the release going
green already implies it, and this is the one that says so by name:

```bash
kubectl exec statefulset/obstack-postgres -- psql -U obstack -d obstack -v ON_ERROR_STOP=1 \
  -c 'SELECT 1 FROM workspaces LIMIT 1' -c 'SELECT 1 FROM saved_views LIMIT 1'
```

Zero rows is a pass — a fresh install has no workspaces until somebody signs
up. A missing relation is a `psql` error, and `ON_ERROR_STOP=1` makes it a
non-zero exit. It asks the database rather than the Job object on purpose:
the install-rendered Job is swept by `ttlSecondsAfterFinished` and the
upgrade-rendered one deletes itself on success, so the database is the only
thing both paths leave behind.

## Credentials and rotation

D253 item 3's floor: **the standard pattern and nothing more.** Every
credential this chart handles — both ClickHouse users' passwords, the
Postgres password, the `web` workload's two auth slots
(`BETTER_AUTH_SECRET`, `OBSTACK_EXPLAIN_API_KEY`), the `ingest` workload's
one optional slot (the Vercel drain signature secret, D287) and, since 0.7.0,
the collector's ingest key (`OBSTACK_COLLECTOR_API_KEY`, the pilot packet's
D687) — resolves
through the same five-group pattern. By default this chart renders its own
Secret (`{{ .Release.Name }}-credentials`, `templates/secret.yaml`) from the
values above; setting `clickhouse.existingSecret` / `postgres.existingSecret` /
`web.existingSecret` / `ingest.existingSecret` / `collector.existingSecret` to
the name of a Secret already
in the cluster sources that group's credentials from it instead — a NAME,
never a value, so the
credential itself never has to pass through `values.yaml`, `--set`, or this
chart's own release manifest. Key names are **fixed by the chart, not
values-configurable**, so a brought Secret has exactly one thing to get right
instead of two: `clickhouse-ingest-password`, `clickhouse-web-password`,
`postgres-password`, `better-auth-secret`, `explain-api-key`,
`vercel-drain-secret`, `collector-api-key`. Five groups,
not seven, because ClickHouse's two users rotate together (both live in
`files/obstack-users.xml`) and the web workload's two auth slots are a third
independent group; `ingest` is a fourth because its one key rotates with a
drain's configuration in someone else's dashboard, on nobody else's schedule;
the collector's key is a fifth because it is a credential the PRODUCT issues
(an `ingest`-scoped `api_keys` row minted in Settings) and rotates from that
page, on the product's schedule rather than any store's.
Both optional keys (`explain-api-key`, `vercel-drain-secret`) are read with
`optional: true`, so a brought Secret may omit either entirely rather than
carrying an empty one — measured live: setting the `existingSecret` values
makes this chart's own Secret disappear entirely (nothing left for it to
say), both StatefulSets' `secretKeyRef.name` move to the brought Secret on
the next `helm upgrade`, and both PVCs keep the same underlying volumes
across the roll. **No external-secrets integration ships here** — D253 item 3
refuses it as a speculative component; the name override is the whole
mechanism.

**Rotation is D123's documented procedure, never automated, and it differs by
credential:**

- **ClickHouse** (`obstack_ingest`/`obstack_web`, D11): both users are
  defined in `files/obstack-users.xml` with `password from_env="…"` — there
  is no `ALTER USER` to run; the password IS whatever the env resolves to at
  ClickHouse's own boot. Update the Secret (this chart's own or your
  `existingSecret`), then roll the pod:
  `kubectl rollout restart statefulset/<release>-clickhouse`. Changing
  `clickhouse.ingestPassword`/`webPassword` on THIS chart's own Secret rolls
  it for you on the next `helm upgrade` — a `checksum/secret` pod-template
  annotation, the same mechanism `checksum/config` already uses for
  `obstack-users.xml` — but rotating an `existingSecret` is invisible to Helm
  at render time, so that roll is always the manual command above.
  **Roll `deployment/<release>-ingest` as well, on either path.** Its pods
  read the password through a `secretKeyRef` (D275), and a reference's NAME
  and KEY do not change when the Secret's DATA does, so nothing rolls them
  for you any more — before D275 the password sat in their DSN literal and a
  `--set` rolled them for free. A ClickHouse that came back on the new
  password while ingest still holds the old one fails every insert until
  those pods restart (loudly — D5 — but the rows are gone).
- **Postgres** (`obstack`): `POSTGRES_PASSWORD` is read by the image's
  entrypoint at initdb time only (see "Postgres in this chart" above) — a
  Secret update alone rotates nothing on a cluster whose data dir already
  exists. Rotating for real is two steps, in order: `ALTER USER obstack WITH
  PASSWORD '<new>'` against the LIVE database, then update the Secret (chart
  Secret or `existingSecret`) to match and roll
  `statefulset/<release>-postgres` **and `deployment/<release>-ingest`** (same
  reason as ClickHouse's above: ingest's Postgres password is a `secretKeyRef`
  too, so a Secret edit alone never reaches a running pod) so the
  migrate/pg-migrate Jobs and ingest's own DSN agree with what the database
  now actually has.
- **`BETTER_AUTH_SECRET`/`OBSTACK_EXPLAIN_API_KEY`**: the `web` workload
  reads both through `secretKeyRef` (`OBSTACK_EXPLAIN_API_KEY` optionally, so
  a brought Secret may omit that key entirely) — update the Secret and roll
  `deployment/<release>-web`. Rotating `BETTER_AUTH_SECRET` invalidates every
  live session; users sign in again.
- **The collector's key** (`collector.apiKey` / `collector.existingSecret`,
  0.7.0): both collector workloads read `OBSTACK_COLLECTOR_API_KEY` through a
  `secretKeyRef` into the `collector-api-key` slot — until 0.7.0 it was a
  `value:` literal in both pod specs, the one credential D275's line had not
  reached. Rotation is the product's: issue a new `ingest` key in Settings →
  API keys, update the Secret, roll `daemonset/<release>-collector` **and**
  `deployment/<release>-collector-cluster`, then revoke the old key on the
  same page (ingest's 30s lookup cache is how long the old key keeps working).
  On this chart's own Secret a `helm upgrade --set collector.apiKey=…` rolls
  both for you — a `checksum/secret` annotation on each pod template, the
  ClickHouse mechanism — but a brought `existingSecret`'s rotation is invisible
  to Helm at render time, so there the roll is always the two manual
  commands. The reference is deliberately NOT `optional`: a collector with no
  key would send `Bearer ` and be 401'd on every batch, quietly; a missing key
  holds the pod in `CreateContainerConfigError` instead, naming the key.

**Closed (D275): every DSN this chart renders resolves `existingSecret`, and
none of them ever carries a password literal on that path.** The migrate Job,
the pg-migrate Job and the ingest `Deployment` all branch on
`clickhouse.existingSecret`/`postgres.existingSecret` the same way the two
StatefulSets do: `existingSecret` set means the password rides a
`secretKeyRef` into an ingest-only env (`OBSTACK_CLICKHOUSE_DSN_PASSWORD` /
`OBSTACK_POSTGRES_DSN_PASSWORD`) instead of the `CLICKHOUSE_DSN` /
`OBSTACK_POSTGRES_DSN` string itself, and the ingest binary folds the two back
into one connection string at boot (`config.InjectDSNPassword`,
`services/ingest/internal/config/config.go`) — additive and optional, a no-op
when unset. The ingest `Deployment` reads this way unconditionally (it is
always a chart-owned or brought Secret, never a literal); the two migrate Jobs
still render the password straight into the DSN literal on the *default*
(chart-owned-Secret) path, unchanged from before this section closed.

**One caveat, orthogonal to secrets and stated in the section above already:**
a password-ROTATING `helm upgrade` on the default (non-`existingSecret`) path
can still race the store's own pod roll for ClickHouse ("Why ClickHouse is a
normal resource" above) — `existingSecret` doesn't have this race at all,
since Helm never renders that Secret's value in the first place.

## The collector DaemonSet's contract

`templates/collector/` packages `deploy/collector/config.yaml`
byte-for-byte (`files/collector-config.yaml`, pinned by the contract test
below) and provides exactly what `deploy/collector/README.md`'s "What
config.yaml assumes of its DaemonSet" section states:

- a `ServiceAccount` bound to a `ClusterRole` granting `get`/`list`/`watch`
  on `pods` and `namespaces` (`k8s_attributes`' `auth_type: serviceAccount`)
  and `get` on `nodes/stats` and `nodes/proxy` (`kubelet_stats`' scrape of the
  node's own kubelet — "The cluster collector" below has the whole rule);
- `/var/log/pods` and `/var/lib/docker/containers` mounted read-only;
- `OBSTACK_COLLECTOR_API_KEY` (since 0.7.0 a `secretKeyRef` into the chart's
  Secret or `collector.existingSecret` — `collector.apiKey` is never a
  pod-spec literal; "Credentials and rotation" above), `OBSTACK_INGEST_ENDPOINT`,
  `OBSTACK_COLLECTOR_EXCLUDE_CONTAINER` (the demo pod's instrumented
  container name — `values.yaml`'s `collector.excludeContainer`) and
  `OBSTACK_COLLECTOR_STORAGE_DIR`;
- `K8S_NODE_IP` (Downward API `status.hostIP`) and `K8S_NODE_NAME`
  (`spec.nodeName`): the kubelet scrape's endpoint, and the node name stamped
  onto pod and container series, which `kubelet_stats` sets on node-level
  resources only. Neither has a default — an unset `K8S_NODE_NAME` stops the
  collector at start-up rather than stamping a placeholder;
- a writable, per-node `hostPath` at `OBSTACK_COLLECTOR_STORAGE_DIR`
  (default `/var/lib/obstack-collector`), `type: DirectoryOrCreate` — the T1
  review escalation's file_storage checkpoint, so a collector restart
  resumes instead of re-shipping every historical line;
- a liveness/readiness probe against `:13133`.

The container runs as root (`securityContext: runAsUser/runAsGroup: 0`),
matching `docker-compose.yml`'s own `user: "0:0"` on the same image and for
the same reason: the node's pod log files and the freshly-created storage
hostPath are both root-owned, and the upstream image's default non-root user
cannot read or write either.

**App-side routing (D37.1):** the demo pod reaches its own node's collector
via the Downward API's `status.hostIP` plus the DaemonSet's `hostPort`
(`4317`/`4318`) rather than a cluster `Service` — the standard DaemonSet
collector pattern, and the only way `k8s_attributes`' `from: connection` pod
association can see a real, un-NATed source IP instead of a Service's. Even
so, a pod calling its own node's IP through a `hostPort` is a same-node
hairpin, and hairpin traffic is commonly SNAT'd for the return path to route
— reproduced while building this chart: `from: connection` alone left
`k8s_namespace`/`k8s_pod` empty on every span. `config.yaml` already carries
a second, documented pod-association rule for exactly this case
(`resource_attribute` `k8s.pod.name`/`k8s.namespace.name`), so the demo
pod's `OTEL_RESOURCE_ATTRIBUTES` stamps both via the Downward API
(`templates/demo/deployment.yaml`) — this is what actually makes SOLID rows carry
pod metadata, not the connection alone. Any app instrumented against this
chart's collector needs the same two resource attributes for the same
reason.

## The cluster collector (events + cluster metrics)

One single-replica Deployment carries everything this release reads from the
API server rather than from a node: the Event stream as logs, and the
cluster's declared state as metrics. They share a workload because they share
the property that decides the topology — both are cluster-wide reads, so
exactly one replica may run them.

**Cluster metrics.** `k8s_cluster` reports what the cluster was TOLD: node
readiness and memory pressure, allocatable CPU and memory, pod phase,
container restarts, and each container's requests and limits — ten series
names, whitelisted `strict` in `files/collector-cluster-config.yaml`. Its
counterpart is the DaemonSet's `kubelet_stats`, which reports what is being
USED. `/app/infra` renders the pair, and neither half is derivable from the
other: a limit exists only in the API server's object, usage only on the node.
Four of the ten names — `k8s.node.condition_*` and `k8s.node.allocatable_*` —
are BUILT from `node_conditions_to_report` / `allocatable_types_to_report`
(`receiver/k8sclusterreceiver/internal/node/nodes.go:196,222` at the pinned
v0.158.0) rather than toggled, so shortening either list deletes those series.
`deploy/collector/README.md`, "Kubernetes metrics", carries the full name list
and the series budget (≈10 per single-container pod; ≈15k for 50 nodes × 30
pods, against a 25k active-series cap).

**Cluster events.** Kubernetes records its own account of what happened to a
workload as `Event` objects — `FailedScheduling`, `Failed` on an image pull, `Unhealthy` from a
probe, the `Killing` that follows an OOM. They are the half of an incident
that never reaches a container's stdout, so nothing the DaemonSet tails can
carry them: a Pod that never started produced no logs to tail. This chart
ships them to ingest as OTLP log records, landing them in `obstack.logs`
alongside application logs instead of leaving them visible only to `kubectl
get events`.

**It is a separate single-replica Deployment, not a receiver added to the
DaemonSet's config, and that is a correctness decision rather than a
packaging one.** Both receivers watch the API server, not the node they
happen to run on, so every replica that runs them receives the entire
cluster's stream. Folding them into `files/collector-config.yaml` would
therefore ship each event and each node fact once per node — a three-node
cluster triple-counts every restart, and the over-count grows with the
cluster rather than staying constant. That is the same class of duplicate
D37.3's filelog exclusion exists to prevent, and it gets the same answer:
don't emit it twice rather than deduplicate afterwards.
`templates/collector/cluster-deployment.yaml` pins `replicas: 1` and
`strategy: Recreate` for exactly that reason — the default RollingUpdate
would briefly run two pods and double-ship across every upgrade.

The pod is deliberately thin next to the DaemonSet's: no `hostPort` and no
OTLP listener at all (nothing sends to it), no host mounts, and none of the
DaemonSet's `runAsUser: 0` override — that exists only for the node's
root-owned log files and the storage `hostPath`, neither of which this pod
touches, so it runs as the image's default non-root user. It reuses the
DaemonSet's ServiceAccount, the same `collector.apiKey`, and the same ingest
endpoint; to ingest it is one more authenticated OTLP client.

**RBAC.** Behind the same values flag as the workload, the collector's
ClusterRole gains `get`/`list`/`watch` on core `events` (a watch on the Event
stream is the entire `k8s_events` receiver) plus the set `k8s_cluster`'s
informers need: core `namespaces`, `namespaces/status`, `nodes`,
`nodes/spec`, `persistentvolumes`, `persistentvolumeclaims`, `pods`,
`pods/status`, `replicationcontrollers`, `replicationcontrollers/status`,
`resourcequotas`, `services`; `discovery.k8s.io` `endpointslices`; `apps`
`daemonsets`, `deployments`, `replicasets`, `statefulsets`; `batch` `jobs`,
`cronjobs`; `autoscaling` `horizontalpodautoscalers`. That is the upstream
receiver's own documented ClusterRole at the pinned v0.158.0, minus the dead
`extensions` API group (gone from Kubernetes since 1.16) and minus the
`events` already granted beside it — nothing wider, and nothing invented.

Gating it on the workload's flag is what keeps it honest: disabling the
feature narrows the role rather than leaving a standing cluster-wide read
nothing in the release consumes. The unconditional part of the rule is the
DaemonSet's alone — `pods`/`namespaces` for `k8s_attributes`, and `get` on
`nodes/stats` and `nodes/proxy` for the kubelet scrape.

`replicasets` used to be documented here as deliberately absent, and it is now
present: that absence was a statement about `k8s_attributes`, which reads no
owner references and still does not. `k8s_cluster`'s informers walk the whole
owner chain (Deployment → ReplicaSet → Pod), so the grant arrives with the
component that needs it and leaves with the flag that turns it off.

**The switch.** `collector.cluster.enabled`, default `true`:

```bash
# the whole feature leaves the release — no Deployment, no ConfigMap, and no
# `events` or cluster-read rules on the ClusterRole
helm template obstack deploy/helm/obstack --set collector.cluster.enabled=false
```

**What it does not do.** There is no `file_storage` checkpoint on either
pipeline, and its absence is a decision. Checkpointing exists in
`config.yaml` because `file_log` reads files from `start_at: beginning` and a
restart would re-ship every historical line; `k8s_events` holds no byte
offset — it opens a watch, and a restarted watch resumes from the API
server's current resource version — and `k8s_cluster` re-lists the world
every 30s, so a restart costs it at most one interval. The honest cost is
that events occurring during a restart or a `Recreate` rollout are not
backfilled. Events are the API server's own short-lived, best-effort records
(default TTL one hour), not a durable log, so a volume bought to chase them
would be a checkpoint over data the cluster itself has already discarded.

No `transform` processor runs on the events pipeline either. The receiver
puts the involved object
on the Resource (`k8s.object.kind`, `k8s.object.name`, `k8s.object.uid`,
`k8s.node.name`) and the event itself on the record (`k8s.event.reason`,
`k8s.event.uid`, `k8s.namespace.name`, …). Ingest promotes only
`k8s.pod.name`/`k8s.namespace.name` from the Resource, so for event rows the
`k8s_pod`/`k8s_namespace` columns stay empty and the reading side takes the
keys out of the stored `resource_attributes`/`attributes` maps exactly as
they land.

## The `files/` copies and their contract test

`deploy/helm/obstack/` cannot reference files outside itself — Helm's
`.Files` is chart-rooted — so two D14/D11-binding artifacts are physical
copies rather than references (K1/D40):

| Source | Chart copy |
|---|---|
| `deploy/compose/clickhouse/users.d/obstack-users.xml` | `files/obstack-users.xml` |
| `deploy/collector/config.yaml` | `files/collector-config.yaml` |

Both are pinned byte-for-byte by
`services/ingest/internal/mapping/chart_contract_test.go`, which runs in the
`go` check on every PR — a drifting copy fails `go test ./...`, not a
customer's cluster.

`files/` holds a third collector config,
`files/collector-cluster-config.yaml` (see "The cluster collector (events +
cluster metrics)" above), and it is deliberately **not** a row in that test.
The two files above are copies — they have a source outside the chart that
they can drift away from, which is the whole thing K1 refuses. The cluster
config has no such source: there is no cluster API under Compose, so
`config.compose.yaml` grows neither of its receivers, and nothing outside
`deploy/helm/obstack/` reads the file. Pinning a copy against a source that
does not exist would be ceremony, not the K1 mechanism, so the pair list
stays at two rows.

## Local repro on kind

Isolated cluster name, never the shared compose stacks this repo also runs
(check `docker ps` first):

```bash
# build the three images this repo's source produces; ClickHouse, Postgres
# and the collector are pulled from their pinned public tags
docker build -t obstack-ingest:kind services/ingest
docker build -t obstack-demo-agent:kind demo/agent-app
docker build -t obstack-web:kind -f apps/web/Dockerfile --build-arg OBSTACK_DATA_MODE=live .

kind create cluster --name t4-chart
kind load docker-image obstack-ingest:kind --name t4-chart
kind load docker-image obstack-demo-agent:kind --name t4-chart
kind load docker-image obstack-web:kind --name t4-chart

helm lint deploy/helm/obstack
# 900s = the migrate Job's own activeDeadlineSeconds, which already contains
# the cold ClickHouse pull (the shared wait-for-clickhouse init container's
# 840s poll budget) — see "--wait and --wait-for-jobs, precisely" above.
# A warm node is done in ~18s.
#
# web.betterAuthSecret is the one value with no default (a committed
# cookie-signing secret in a distributable chart is a shipped vulnerability),
# and it is not optional: a live-stamped web image booted without it refuses
# to serve, so `--wait` would sit on a crash-looping pod until the timeout.
helm install obstack deploy/helm/obstack --timeout 900s --wait \
  --set "web.betterAuthSecret=$(openssl rand -base64 32)"

# every component Ready — the two PVCs Bound alongside them
kubectl get pods,deploy,sts,ds,pvc

# the install-time migrate Job (name is revision-suffixed) applied the
# schema; ingest only ever verified it — its pods held in Init:0/2 until
# ClickHouse and Postgres answered, and zero refusals here is the expected
# clean run (see "the migrate Job renders two ways")
kubectl logs job/obstack-migrate-1 -c migrate
kubectl logs deploy/obstack-ingest | grep "schema verified"

# the other store's Job, same shape, same revision suffix — and then the
# claim itself, asked of Postgres rather than of the Job (see "Postgres in
# this chart"; the second line is what CI's `stack` job runs)
kubectl logs job/obstack-pg-migrate-1 -c pg-migrate
kubectl exec statefulset/obstack-postgres -- psql -U obstack -d obstack -v ON_ERROR_STOP=1 \
  -c 'SELECT 1 FROM workspaces LIMIT 1' -c 'SELECT 1 FROM saved_views LIMIT 1'

# no-op re-run — this time a `pre-upgrade` hook. It is deleted on success
# (hook-succeeded), so read its log while the upgrade is still running, from
# a second shell (its name carries the new revision):
#   until kubectl logs job/obstack-migrate-2 -c migrate 2>/dev/null; do sleep 1; done
#   -> {"msg":"schema already up to date"}
helm upgrade obstack deploy/helm/obstack --timeout 300s --wait

# ordering, when an upgrade carries a real schema change: the pre-upgrade
# hook Job completes before any upgraded ingest pod is even created —
# visible in the event stream, not inferred from the outcome
kubectl get events --sort-by=.metadata.creationTimestamp | grep -E "migrate|ingest"

# falsification probe: un-migrated ClickHouse
kubectl exec statefulset/obstack-clickhouse -- clickhouse-client \
  --user obstack_ingest --password obstack_ingest_dev --query "DROP DATABASE obstack"
kubectl rollout restart deployment/obstack-ingest
kubectl logs -l app.kubernetes.io/component=ingest --tail=5
# -> "schema migrations 0001_spans, 0002_logs, 0003_trace_summaries
#     unapplied and OBSTACK_MIGRATE_ON_BOOT is false; run `ingest migrate`
#     first"

# clean uninstall — every resource this release owns goes, now that all of
# them are normal and release-managed. Two things are not release resources
# and therefore stay, both measured: the two PVCs (Kubernetes' own default —
# a StatefulSet never deletes the volumes its ordinals claimed, precisely so
# an accidental `helm uninstall` cannot delete data by itself; kept rather
# than overridden — see "Upgrading from 0.2.0" for the one place this chart
# DOES want a clean start), and any migrate Job left over from an upgrade
# that failed or timed out. Hook resources live outside the release
# manifest, and `hook-succeeded` only sweeps the ones that passed while Helm
# was still watching; the rest linger, labelled, until someone removes them.
helm uninstall obstack --timeout 300s
kubectl get all,cm,sa,clusterrole,clusterrolebinding -l app.kubernetes.io/instance=obstack
kubectl delete job -l app.kubernetes.io/component=migrate   # only after a failed upgrade
kubectl get pvc -l app.kubernetes.io/instance=obstack       # both still Bound — deliberate
kubectl delete pvc -l app.kubernetes.io/instance=obstack    # only when a run must start empty

kind delete cluster --name t4-chart
```

## Running the acceptance (the same thing CI runs)

The sprint's exit assertion is one script, `acceptance.sh`, and the `stack`
CI job (`.github/workflows/stack.yml`) runs exactly it (S2.1 L3 — no
CI-only sequence, no CI-only timeout arithmetic: the Helm budgets above,
900s cold install / 300s upgrade, live in the script). It checks the chart's
CPU-request budget before anything else (see "The node's CPU-request budget"
— a render-time fact, asked in a second rather than discovered fifteen
minutes into a `--wait`), builds this
repo's three images, side-loads every pinned image into the kind node (an
optimization, not a correctness mechanism — without it the node pulls the
same tags itself inside the install budget), installs or upgrades the chart
with a per-run `web.betterAuthSecret` (`WEB_AUTH_SECRET`, generated with
`openssl rand -base64 32` — exactly what a real operator supplies; every
other value stays a chart default), fires `POST /chat`, and asserts:

Two of the checks are not telemetry. The first step of the run is the
CPU-request budget — `acceptance.ts budget`, which renders the chart, prints
the per-workload table and refuses the run if the total no longer fits the
node (990m against a 1000m budget today); it touches no cluster, so it costs
a second and it is why a footprint regression is now a named failure instead
of a 900s `--wait` timeout. The `web` workload's own check is a `/login`
probe over a port-forward, and it is the boot check passing: the image's
stamp matched `OBSTACK_DATA_MODE` and the release's `BETTER_AUTH_SECRET`
reached the pod. The telemetry
assertions run through the D17 tsx facade harness (`acceptance.ts` — the
app's own `@/server/data` facade against the cluster's ClickHouse, the same
code the web image serves, driven without a browser):

- the four-layer waterfall (api/agent/tool/llm), token counts and a
  non-zero priced cost — the same shared checks compose's `smoke.sh` runs
  (`deploy/compose/trace-checks.ts`);
- **D37.1** ≥1 SOLID log row carrying the trace's `trace_id` AND populated
  `k8s_namespace`/`k8s_pod`;
- **D43** the standing guard: every span of the trace carries a non-empty
  `k8s_node` — the only observable evidence `k8s_attributes` is alive on the
  app-OTLP path (SOLID `k8s_namespace`/`k8s_pod` come from the app's own
  stamping, NEARBY's from the filelog path), so a reverted association order
  or a collector bump that broke it goes red instead of silently regressing;
- **D37.2** ≥1 NEARBY row from the uninstrumented `sidecar` container —
  zero is a red check, never a silent pass;
- **D37.3** zero duplicated bodies across the OTLP and filelog paths, in
  both shapes: the same `(atMs, body)` twice, and a trace-less row whose
  body contains an OTLP-shipped body (the exclusion-removed shape);
- the T1 rider: `kubectl rollout restart` of the collector DaemonSet, a
  second `/chat` proving the restarted pipeline live end-to-end, then the
  first trace re-checked — previously-shipped lines must NOT re-ship
  (`file_storage` checkpointing);
- the D38(e) rider: an event-form GenAI log record
  (`gen_ai.input.messages`/`gen_ai.output.messages`) sent through the
  collector's own OTLP endpoint lands with `prompt`/`completion` filled
  verbatim;
- the S4.4 rider, last because it deletes the demo pod: the events collector
  Deployment is Available, a third `/chat` runs, and the pod that served it
  is deleted — the kubelet's `Killing` event on exactly that Pod reaches
  that trace's `Trace.k8sEvents` through the facade, as `kind: "restart"`,
  `severity: "info"`, inside the ±10s nearby window. This is the evidence
  behind the product's "k8s events on the timeline" claim; without it the
  claim would be about a pipeline nothing had run.

Prerequisites: `docker`, `kind`, `helm`, `kubectl`, `curl` on PATH; a kind
cluster as the current kubectl context; `npm ci` run once at the repo root
(the harness runs via tsx). Then:

```bash
kind create cluster --name t5
bash deploy/helm/obstack/acceptance.sh
kind delete cluster --name t5
```

Re-running against a cluster that already has the release takes the
`helm upgrade` path (300s budget) — the pre-upgrade migrate hook runs as a
no-op and the same assertions repeat. The script port-forwards ClickHouse,
the demo Service, the web Service and the collector on
18123/18000/13000/14318 (overridable via `CLICKHOUSE_PORT`/`DEMO_PORT`/
`WEB_PORT`/`COLLECTOR_PORT`), deliberately off the compose stack's ports so
a running compose stack is never what it asserts against. `WEB_AUTH_SECRET`
is overridable too; unset, each run generates its own.
