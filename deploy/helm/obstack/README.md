# obstack Helm chart

The real Helm chart M4 extends in place (D35) — not a throwaway kind
manifest and not a first draft superseded later. Installs the obstack stack
on Kubernetes: CI-grade ClickHouse, the ingest service (Deployment + its
migrate `Job`), the `obstack-collector` DaemonSet running T1's config
byte-for-byte, and a demo app pod carrying a second, uninstrumented
container.

## Scope boundary (D35) — read this before extending the chart

**In scope now (M2/S2.2):**

- CI-grade ClickHouse, both D11 users (`obstack_ingest`, `obstack_web`).
- The ingest `Deployment` (`OBSTACK_MIGRATE_ON_BOOT=false`) plus a migrate
  `Job` as a `pre-install`/`pre-upgrade` hook — the split
  `deploy/compose/README.md:147-186` designed and this chart is the first
  real execution of.
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

## Why ClickHouse is a pre-install hook, not a normal resource

The migrate `Job` (`templates/ingest/migrate-job.yaml`) has to be a
`pre-install`/`pre-upgrade` hook — that is PR #4's design, not a chart
preference. Helm's hook model turned out to have a consequence worth
recording rather than rediscovering: **Helm creates every pre-install hook
resource, in `helm.sh/hook-weight` order, and waits for the hooks to finish
before it creates any of the chart's normal (non-hook) resources.** Proven,
not assumed — a plain, non-hook Deployment in the same chart as a
pre-install Job genuinely does not exist yet, at the API server, while that
Job's pod is running.

That means a migrate `Job` cannot assume a normal ClickHouse resource is
there to migrate against on a from-scratch `helm install` — it wouldn't be.
So ClickHouse (`templates/clickhouse/deployment.yaml`, `service.yaml`,
`configmap-users.yaml`) is a pre-install hook too, at weight `-5` (before the
migrate Job's `0`), purely so it *exists* by the time the Job runs. Helm
does not additionally wait for a hook Deployment's rollout to finish before
moving to the next weight — only Job completion blocks — so the migrate
Job's own `wait-for-clickhouse` initContainer is what makes ClickHouse
*actually reachable* by the time `/ingest migrate` runs, playing the same
role `docker-compose.yml`'s `depends_on: condition: service_healthy` plays
for the ingest container.

ClickHouse is annotated `pre-install` only, never `pre-upgrade`: once
created it is never deleted or recreated by a later `helm upgrade` (Helm's
default hook-delete-policy, `before-hook-creation`, only fires the next time
the *same* hook event fires again), so its `emptyDir` survives every upgrade
in a release's lifetime — sufficient for CI/kind, where the whole cluster is
thrown away between runs, and exactly what "CI-grade" means here as opposed
to what M4 needs from a production ClickHouse.

**Known limitations, not silently inherited.** Both follow from the same
fact — an install-hook resource is created once and is not part of the
release's managed manifest — and both were reproduced while building this
chart, not inferred:

1. **`helm uninstall` does not remove ClickHouse** (Deployment, Service,
   ConfigMap). A *failed* `helm install` leaves them running too, with the
   release in `failed` state and nothing to uninstall.
2. **Every `clickhouse.*` value is inert after the first install.**
   `helm upgrade --set clickhouse.image=…` leaves the running Deployment on
   its original image; the ClickHouse hook is never re-applied. Worse,
   `--set clickhouse.ingestPassword=…` on an existing release *does* change
   the DSN the migrate Job and the ingest Deployment use while leaving the
   ClickHouse user's password as installed — the pre-upgrade hook then fails
   authentication and the upgrade fails. Change a `clickhouse.*` value only
   at install time; on an existing release, reinstall.

Clean up by hand if you `helm uninstall` outside a throwaway cluster:

```bash
kubectl delete deploy,svc,configmap -l app.kubernetes.io/instance=<release>
```

Every kind-based done-check in this repo tears down the whole cluster
instead of uninstalling, so this never bites CI. **M4**, which wants
ClickHouse to survive a pod eviction (this chart's `emptyDir` does not)
should replace this Deployment with a StatefulSet and a PVC rather than
inherit the hook-chaining trick silently — at that point revisit whether a
`pre-delete` hook or a different lifecycle entirely is the right fix for the
uninstall gap too.

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
# 600s, not a minute or two: a node that has never run this chart pulls
# clickhouse/clickhouse-server (~250 MB) before anything else can start, and
# nothing here fakes that away. Pre-pull it (`docker pull` + `kind load
# docker-image`) if you want the ~90s install instead.
helm install obstack deploy/helm/obstack --timeout 600s --wait

# every component Ready
kubectl get pods,deploy,ds

# migrate ran before ingest, and ingest only verified
kubectl get events --sort-by=.metadata.creationTimestamp
kubectl logs deploy/obstack-ingest | grep "schema verified"

# no-op re-run. The Job is deleted on success by hook-delete-policy, so read
# its log while the upgrade is still running, from a second shell:
#   until kubectl logs job/obstack-migrate -c migrate 2>/dev/null; do sleep 1; done
#   -> {"msg":"schema already up to date"}
helm upgrade obstack deploy/helm/obstack --timeout 600s --wait

# falsification probe: un-migrated ClickHouse
kubectl exec deploy/obstack-clickhouse -- clickhouse-client \
  --user obstack_ingest --password obstack_ingest_dev --query "DROP DATABASE obstack"
kubectl rollout restart deployment/obstack-ingest
kubectl logs -l app.kubernetes.io/component=ingest --tail=5
# -> "schema migrations 0001_spans, 0002_logs, 0003_trace_summaries
#     unapplied and OBSTACK_MIGRATE_ON_BOOT is false; run `ingest migrate`
#     first"

kind delete cluster --name t4-chart
```

D37's three-part evidence (SOLID rows with pod metadata, a NEARBY row from
the sidecar, zero duplicated bodies) is queryable straight from ClickHouse
once the stack is up — send `POST /chat` at the demo pod's Service
(`obstack-demo:8000`) and read `obstack.spans`/`obstack.logs`. T5 wires this
into CI as the sprint's signed exit evidence.
