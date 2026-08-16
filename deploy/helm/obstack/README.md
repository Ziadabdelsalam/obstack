# obstack Helm chart

The real Helm chart M4 extends in place (D35) — not a throwaway kind
manifest and not a first draft superseded later. Installs the obstack stack
on Kubernetes: CI-grade ClickHouse, the ingest service (Deployment + its
migrate `Job`), the `obstack-collector` DaemonSet running T1's config
byte-for-byte, and a demo app pod carrying a second, uninstrumented
container.

## Scope boundary (D35) — read this before extending the chart

**In scope now (M2/S2.2):**

- CI-grade ClickHouse, both D11 users (`obstack_ingest`, `obstack_web`), as
  normal, release-managed resources.
- The ingest `Deployment` (`OBSTACK_MIGRATE_ON_BOOT=false`) plus a migrate
  `Job` — the split `deploy/compose/README.md:147-186` designed and this
  chart is the first real execution of. One template, two renderings: a
  normal Job on install, a `pre-upgrade` hook on upgrade — see "Why
  ClickHouse is a normal resource, and the migrate Job renders two ways"
  below.
- The `obstack-collector` DaemonSet, running `deploy/collector/config.yaml`
  byte-for-byte, with the RBAC, hostPath mounts and env `config.yaml` names
  as its DaemonSet's job (`deploy/collector/README.md`, "What config.yaml
  assumes of its DaemonSet").
- A demo app pod: the instrumented `demo-agent` container (OTLP routed
  through the collector, D37.1) plus a second, uninstrumented `sidecar`
  container whose stdout is the genuine NEARBY log source (D37.2).
- Every image pinned to an exact tag (D14); the two images built from this
  repo (`ingest`, `demo-agent`) are built locally and loaded into kind
  (`imagePullPolicy: Never`, S2.0's precedent) — no registry in the path.

**Explicitly NOT in scope (D35) — this is M4's job, not a gap to silently
fill:**

- The `web` image. CI asserts the M2 exit through the D17 tsx facade harness
  against the cluster's ClickHouse instead (T5).
- TTL tiers, docs content, self-hosted values (ingress, TLS, resource
  sizing/HA, a secret-backend story). `values.yaml` carries plain dev/CI
  defaults, the same shape `docker-compose.yml` already uses — there is no
  chart-owned `Secret`.
- A second chart. M4 extends this one in place; a parallel chart is drift.
- Durable ClickHouse storage. The data dir is a per-node `hostPath`
  (release-scoped, `/var/lib/obstack-clickhouse/<release>`) so the schema
  survives pod replacement within a release's lifetime — enough for
  CI/kind, where the cluster is thrown away afterwards. M4 replaces the
  Deployment + hostPath with a StatefulSet and a PVC rather than inheriting
  it silently. Three consequences of node-disk storage, stated here rather
  than left for M4 to rediscover — a PVC would have none of them:
  - **`helm uninstall` does not remove the data.** Every *cluster* resource
    goes; the node's `/var/lib/obstack-clickhouse/<release>` directory stays.
    A later `helm install` of the *same* release name on the same node
    adopts that database wholesale — measured: the reinstall's migrate Job
    logged `schema already up to date` and the previous release's tables were
    all still there. Wipe it (`docker exec <node> rm -rf
    /var/lib/obstack-clickhouse/<release>`) or throw the cluster away when a
    run has to start from empty data.
  - **Single node only.** A `hostPath` follows the node, not the pod, and
    nothing pins this Deployment to one node. On a multi-node cluster a
    rescheduled ClickHouse pod comes up on a fresh, empty
    `DirectoryOrCreate` directory — the same schema-loss wedge the hostPath
    exists to prevent, just moved to another trigger. kind's single node is
    the assumption everywhere below.
  - **One release per cluster.** The path carries the release name but not
    its namespace, and the collector's ClusterRole/ClusterRoleBinding are
    named the same way, so two same-named releases in different namespaces
    would share a data directory and fight over cluster-scoped RBAC.

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
pull took). The ingest pods therefore sit in `Init:0/1` with zero restarts
while ClickHouse pulls; their verify-and-refuse boot check
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

- **The hook authenticates with the password the cluster is running, not
  the one the values now say.** On a password-rotating upgrade the hook runs
  *before* ClickHouse's env changes, so its DSN is built by the
  `obstack.migrate.clickhousePassword` helper (`_helpers.tpl`), which
  `lookup`s the live Deployment. The new password lands on ClickHouse and on
  ingest's DSN together, in the same post-hook batch.
- **The schema survives a ClickHouse pod replacement.** An upgrade that
  changes `clickhouse.image`, a password, or the users XML rolls the
  ClickHouse pod (`strategy: Recreate` — two servers must never open one
  data dir). The data dir is a release-scoped hostPath precisely so the
  schema the hook applied is still there when the replacement pod comes up;
  with an emptyDir, that same upgrade would wedge — the hook has already
  run, nothing re-migrates, and rolled ingest pods would refuse forever.

Either way, the invariant this section replaced never changed: **exactly one
process applies the schema per revision, and every serving pod only ever
verifies** (`deploy/compose/README.md`'s "Exactly one migration runner per
upgrade").

### `--wait` and `--wait-for-jobs`, precisely

- `helm install --wait` does **not** wait for a normal Job to complete, and
  the install-rendered migrate Job is a normal Job — but the green is still
  trustworthy: ingest's Deployment cannot report Available until its pods
  verify the schema, which cannot happen before the migrate Job has applied
  it. Add `--wait-for-jobs` if you also want Helm to block on the Job
  object itself; it changes nothing about correctness.
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
- On a cold install expect the ingest pods (and the migrate Job's pod) to
  sit in `Init:0/1` with zero restarts while ClickHouse pulls — a restart on
  an ingest pod now means a schema refusal or a defect, never pull speed.
  Expect a short ClickHouse gap during any upgrade that rolls it
  (`Recreate`): already-running ingest pods crash-loop through it (init
  containers gate startup only), and a rolling upgrade's *new* pods hold in
  `Init` while the old ones serve. All of it converges on its own; none of
  it needs intervention.

## The collector DaemonSet's contract

`templates/collector/` packages `deploy/collector/config.yaml`
byte-for-byte (`files/collector-config.yaml`, pinned by the contract test
below) and provides exactly what `deploy/collector/README.md`'s "What
config.yaml assumes of its DaemonSet" section states:

- a `ServiceAccount` bound to a `ClusterRole` granting `get`/`list`/`watch`
  on `pods` and `namespaces` (`k8s_attributes`' `auth_type: serviceAccount`);
- `/var/log/pods` and `/var/lib/docker/containers` mounted read-only;
- `OBSTACK_COLLECTOR_API_KEY`, `OBSTACK_INGEST_ENDPOINT`,
  `OBSTACK_COLLECTOR_EXCLUDE_CONTAINER` (the demo pod's instrumented
  container name — `values.yaml`'s `collector.excludeContainer`) and
  `OBSTACK_COLLECTOR_STORAGE_DIR`;
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

## Local repro on kind

Isolated cluster name, never the shared compose stacks this repo also runs
(check `docker ps` first):

```bash
# build the two images this repo's source produces; ClickHouse and the
# collector are pulled from their pinned public tags
docker build -t obstack-ingest:kind services/ingest
docker build -t obstack-demo-agent:kind demo/agent-app

kind create cluster --name t4-chart
kind load docker-image obstack-ingest:kind --name t4-chart
kind load docker-image obstack-demo-agent:kind --name t4-chart

helm lint deploy/helm/obstack
# 900s = the migrate Job's own activeDeadlineSeconds, which already contains
# the cold ClickHouse pull (the shared wait-for-clickhouse init container's
# 840s poll budget) — see "--wait and --wait-for-jobs, precisely" above.
# A warm node is done in ~18s.
helm install obstack deploy/helm/obstack --timeout 900s --wait

# every component Ready
kubectl get pods,deploy,ds

# the install-time migrate Job (name is revision-suffixed) applied the
# schema; ingest only ever verified it — its pods held in Init:0/1 until
# ClickHouse answered, and zero refusals here is the expected clean run
# (see "the migrate Job renders two ways")
kubectl logs job/obstack-migrate-1 -c migrate
kubectl logs deploy/obstack-ingest | grep "schema verified"

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
kubectl exec deploy/obstack-clickhouse -- clickhouse-client \
  --user obstack_ingest --password obstack_ingest_dev --query "DROP DATABASE obstack"
kubectl rollout restart deployment/obstack-ingest
kubectl logs -l app.kubernetes.io/component=ingest --tail=5
# -> "schema migrations 0001_spans, 0002_logs, 0003_trace_summaries
#     unapplied and OBSTACK_MIGRATE_ON_BOOT is false; run `ingest migrate`
#     first"

# clean uninstall — every resource this release owns goes, now that all of
# them are normal and release-managed. Two things are not release resources
# and therefore stay, both measured: the node-side hostPath data dirs (files
# on a throwaway node — see the scope boundary), and any migrate Job left
# over from an upgrade that failed or timed out. Hook resources live outside
# the release manifest, and `hook-succeeded` only sweeps the ones that
# passed while Helm was still watching; the rest linger, labelled, until
# someone removes them.
helm uninstall obstack --timeout 300s
kubectl get all,cm,sa,clusterrole,clusterrolebinding -l app.kubernetes.io/instance=obstack
kubectl delete job -l app.kubernetes.io/component=migrate   # only after a failed upgrade

kind delete cluster --name t4-chart
```

## Running the acceptance (the same thing CI runs)

The sprint's exit assertion is one script, `acceptance.sh`, and the `stack`
CI job (`.github/workflows/stack.yml`) runs exactly it (S2.1 L3 — no
CI-only sequence, no CI-only timeout arithmetic: the Helm budgets above,
900s cold install / 300s upgrade, live in the script). It builds this
repo's two images, side-loads every pinned image into the kind node (an
optimization, not a correctness mechanism — without it the node pulls the
same tags itself inside the install budget), installs or upgrades the
chart, fires `POST /chat`, and asserts through the D17 tsx facade harness
(`acceptance.ts` — the app's own `@/server/data` facade against the
cluster's ClickHouse, because the `web` image is deliberately not in this
chart):

- the four-layer waterfall (api/agent/tool/llm), token counts and a
  non-zero priced cost — the same shared checks compose's `smoke.sh` runs
  (`deploy/compose/trace-checks.ts`);
- **D37.1** ≥1 SOLID log row carrying the trace's `trace_id` AND populated
  `k8s_namespace`/`k8s_pod`;
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
  verbatim.

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
the demo Service and the collector on 18123/18000/14318 (overridable via
`CLICKHOUSE_PORT`/`DEMO_PORT`/`COLLECTOR_PORT`), deliberately off the
compose stack's ports so a running compose stack is never what it asserts
against.
