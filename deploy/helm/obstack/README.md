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
  it silently.

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
ordering between any of them here. Its `wait-for-clickhouse` initContainer
polls ClickHouse's `/ping` and holds `/ingest migrate` back until ClickHouse
actually answers (playing the same role compose's `depends_on: condition:
service_healthy` plays for the ingest container — and keeping the Job's
`backoffLimit` a signal about migrate *failing*, not about how long the
~250 MB ClickHouse cold pull took). Until the Job succeeds, ingest's own
verify-and-refuse boot check (`OBSTACK_MIGRATE_ON_BOOT=false`,
`templates/ingest/deployment.yaml`) crash-loops the serving pods — loudly,
with the exact documented error. **That brief crash-loop is the safety
mechanism visibly working, not a defect**: the same invariant boot-time
migration has always enforced ("nothing serves a schema it does not
recognise"), just observable for a few restarts on a cold install instead of
instantly. `ttlSecondsAfterFinished` cleans the completed Job up — there is
no hook-delete-policy on an install, because this Job isn't a hook here.

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
  stop refusing, which cannot happen before the migrate Job has applied the
  schema. Add `--wait-for-jobs` if you also want Helm to block on the Job
  object itself; it changes nothing about correctness.
- On `helm upgrade`, the migrate Job is a hook, and Helm **always** waits
  for hook Jobs to complete before touching any normal resource —
  `--wait-for-jobs` adds nothing there. If an upgrade seems to hang before
  anything rolls, look at the hook Job's pod first (`kubectl describe job
  <release>-migrate-<new revision>`): a hook that cannot finish blocks the
  whole upgrade until `--timeout`.
- One `--timeout` spans both phases (hooks + resource waits). On a node that
  has never pulled `clickhouse/clickhouse-server`, the cold pull alone was
  measured at 7m28s, and a full cold `install --wait` at 11m30s end-to-end —
  hence `--timeout 900s` below, matching the Job's own
  `activeDeadlineSeconds`. Pre-pull (`docker pull` + `kind load
  docker-image`) if you want a much faster install.
- Expect brief `CrashLoopBackOff` on the ingest pods during a cold install
  (see above) and a short ClickHouse gap during any upgrade that rolls it
  (`Recreate`). Both converge on their own; neither needs intervention. The
  cold-install tail is mostly `CrashLoopBackOff`'s own capped backoff: once
  the migrate Job succeeds, ingest's next retry can be up to five minutes
  out, and that wait is part of the measured 11m30s.

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
# 900s, matching the migrate Job's activeDeadlineSeconds — see "--wait and
# --wait-for-jobs, precisely" above for what the timeout covers and why a
# cold node needs this much
helm install obstack deploy/helm/obstack --timeout 900s --wait

# every component Ready
kubectl get pods,deploy,ds

# the install-time migrate Job (name is revision-suffixed) applied the
# schema; ingest only ever verified it, possibly after a few refusals while
# ClickHouse was still starting (see "the migrate Job renders two ways")
kubectl logs job/obstack-migrate-1 -c migrate
kubectl logs deploy/obstack-ingest | grep "schema verified"

# no-op re-run — this time a `pre-upgrade` hook. It is deleted on success
# (hook-succeeded), so read its log while the upgrade is still running, from
# a second shell (its name carries the new revision):
#   until kubectl logs job/obstack-migrate-2 -c migrate 2>/dev/null; do sleep 1; done
#   -> {"msg":"schema already up to date"}
helm upgrade obstack deploy/helm/obstack --timeout 900s --wait

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

# clean uninstall — nothing is left behind now that every resource is
# normal and release-managed (the node-side hostPath data dirs are files on
# a throwaway node, not cluster resources)
helm uninstall obstack --timeout 300s
kubectl get all,cm,sa,clusterrole,clusterrolebinding -l app.kubernetes.io/instance=obstack

kind delete cluster --name t4-chart
```

D37's three-part evidence (SOLID rows with pod metadata, a NEARBY row from
the sidecar, zero duplicated bodies) is queryable straight from ClickHouse
once the stack is up — send `POST /chat` at the demo pod's Service
(`obstack-demo:8000`) and read `obstack.spans`/`obstack.logs`. T5 wires this
into CI as the sprint's signed exit evidence.
