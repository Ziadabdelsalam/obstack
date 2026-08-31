# obstack-collector

A distribution, not a fork (D14, PRD §5): `obstack-collector` is the upstream
OpenTelemetry Collector, unmodified, configured by the two files in this
directory. It receives OTLP (traces and logs) from instrumented apps, tails
container stdout/stderr with the filelog receiver, attaches pod/container
identity, and forwards everything to ingest with the workspace's bearer key.

Two config files, one per topology:

| File | Form | Runs under |
|------|------|------------|
| `config.yaml` | Kubernetes / DaemonSet | T4's chart, byte-for-byte as the ConfigMap |
| `config.compose.yaml` | Docker Compose | this repo's `collector` compose profile |

They are separate files, not one file with an environment switch, because
`k8s_attributes` needs a Kubernetes API to query and `file_log` needs the
kubelet's `/var/log/pods` convention — neither exists under Compose. Compose
tails Docker's own json-file container logs instead and carries no
`k8s_attributes` stage; see `config.compose.yaml`'s header for the detail.
Both files share everything else: the OTLP receiver, the bearer-key export
to ingest, the filelog exclusion pattern below, and the `file_storage`
checkpointing further down.

A third config for the same image exists but is not in this directory and is
not a topology of these two: `deploy/helm/obstack/files/collector-events-config.yaml`,
the chart-owned cluster-events collector — see "Cluster events" below.

## Image

`otel/opentelemetry-collector-k8s:0.158.0` (D14 — pinned to the exact patch,
never a floating tag). This is deliberate: `otel/opentelemetry-collector`
(core) ships neither `file_log` nor `k8s_attributes`, and
`otel/opentelemetry-collector-contrib` (full contrib) ships components this
distro has no use for. `opentelemetry-collector-k8s` is upstream's own
curated middle distro for exactly this job. Verified, not assumed:

```bash
docker run --rm otel/opentelemetry-collector-k8s:0.158.0 components
```

lists both `file_log` (`receiver/filelogreceiver`) and `k8s_attributes`
(`processor/k8sattributesprocessor`), plus the `otlp` receiver and
`otlp_http` exporter both configs use. The same distro carries `k8s_events`
(`receiver/k8seventsreceiver`), which is why the chart's events collector
runs on this identical pin rather than needing full contrib — confirmed the
same way, and by `validate` rejecting an unknown component outright:

```bash
docker run --rm -v "$PWD/../helm/obstack/files/collector-events-config.yaml:/etc/otelcol/config.yaml" \
  otel/opentelemetry-collector-k8s:0.158.0 validate --config=/etc/otelcol/config.yaml
```

## Bearer key (D39 rider)

Both configs read `OBSTACK_COLLECTOR_API_KEY` from the environment and send
it as `Authorization: Bearer <key>` to ingest — the same wire format any
OTLP client uses (D4). `config.compose.yaml` defaults it to `ok_dev_local`
(M1 precedent), which resolves because ingest's Postgres migrations seed it
as a real key row (`services/ingest/pgmigrations/0004_api_keys.sql`) — so the
profile works out of the box for local dev. Keys are Postgres rows now (D98),
never an ingest environment variable, and only their SHA-256 is stored;
`ok_dev_local` keeps working unchanged because that row is seeded for it.
`config.yaml` has no default: production supplies a key issued in settings
through a Helm values file or a mounted secret. Neither file ever carries a
literal key.

## The filelog exclusion (D37.3) — the recommended customer pattern

A container whose OTel SDK already exports logs via OTLP should not also
have its stdout tailed by filelog: that is the same log line landing twice —
once with real trace context, once without. The fix is to exclude that
container from filelog entirely, not to deduplicate after the fact (D37.5
rejects query-layer dedupe for the same reason: it would have to guess which
copy is authoritative).

**On Kubernetes**, exclude by container name — the pod log path already
names it, so no lookup is needed:

```yaml
file_log:
  exclude:
    - /var/log/pods/*/<your-instrumented-container-name>/*.log
```

`config.yaml` ships exactly that line with the container name supplied by
the deployment, as `OBSTACK_COLLECTOR_EXCLUDE_CONTAINER`, so the chart's
ConfigMap can stay a byte-for-byte copy of the file instead of an edited
fork of it. Unset, it falls back to a sentinel that matches no path — a
collector that never excludes anything, which is why the falsification probe
below exists. More than one instrumented container: add the literal globs to
the list.

**Under Docker Compose**, the log path is keyed by container ID instead of
name, and the ID does not exist until the container does, so `up.sh`
resolves it once at bring-up and passes it in as an environment variable,
used in both `include` (there has to be a file to exclude) and `exclude`.
The mechanism is the same idea (exclude this container's log file), adapted
to the identifier Compose actually gives you. `include` is also scoped, not
the host-wide `/var/lib/docker/containers/*/*.log` glob — see
`config.compose.yaml`'s comment for why tailing every container on the
machine is the wrong default even in dev.

### Falsification probe (S2.0 L1)

Proven by removing the exclusion and watching the same line land twice, not
by inspecting the config and assuming it works. The collector's own `--set`
flag overrides one config property without touching the shipped file or its
env-var wiring (`--help`: "Array config properties are overridden"):

```bash
# with the exclusion in place (up.sh's normal path): a chat request's log
# lines are OTLP-shipped only — filelog does not also produce a copy.
bash deploy/collector/up.sh
curl -fsS -X POST http://127.0.0.1:8000/chat -H 'content-type: application/json' -d '{"message":"probe"}'
docker exec obstack-clickhouse clickhouse-client --user obstack_web --password obstack_web_dev \
  --query "SELECT count() FROM obstack.logs WHERE body LIKE '%chat request received: probe%'"
# -> 1 (the OTLP-shipped row, with a real trace_id)

# same containers, same everything, except the exclude list is overridden to
# empty for this one run — up.sh already exported the two container-ID env
# vars `include` and `exclude` both need. The one-off collector also gets its
# own OBSTACK_COLLECTOR_STORAGE_DIR: file_storage (see Checkpointing below)
# takes an exclusive lock on its directory, so sharing the running
# collector's `collector-storage` volume fails the probe at startup with
# `cannot start pipelines: failed to start "file_log" receiver: storage
# client: timeout` — and a private, empty checkpoint is what this probe
# wants anyway, since it is asking filelog to read a file from the top.
docker compose -f deploy/compose/docker-compose.yml --profile collector run --rm \
  -e OBSTACK_COLLECTOR_TAIL_CONTAINER_ID -e OBSTACK_COLLECTOR_EXCLUDE_CONTAINER_ID -e OBSTACK_COLLECTOR_API_KEY \
  -e OBSTACK_COLLECTOR_STORAGE_DIR=/tmp/obstack-collector-probe \
  --entrypoint /otelcol-k8s collector \
  --config /etc/otelcol/config.yaml --set 'receivers.file_log.exclude=[]'
# ... after another chat request through the demo app ...
docker exec obstack-clickhouse clickhouse-client --user obstack_web --password obstack_web_dev \
  --query "SELECT count() FROM obstack.logs WHERE body LIKE '%chat request received%'"
# -> 2 for that request's body (the OTLP-shipped row still carries the real
#    trace_id; the filelog copy, with trace_id = '', is the same line a
#    second time — the duplicate the exclusion exists to prevent)
```

## Pod identity for OTLP senders (D43) — stamp, don't trust the connection

An app that routes OTLP through this collector should stamp its own
identity onto its Resource via the Downward API:

```yaml
- name: OTEL_RESOURCE_ATTRIBUTES
  value: k8s.pod.name=$(POD_NAME),k8s.namespace.name=$(POD_NAMESPACE)
```

**Stamping guarantees identity; connection association is best-effort
behind NAT.** `config.yaml`'s `pod_association` therefore leads with the
stamped attributes and keeps `from: connection` as the fallback — it works
wherever the collector sees the pod's real source IP, and measurably does
not survive a same-node hostIP + hostPort hairpin (the very topology a
DaemonSet collector invites), where SNAT discards the source IP. A sender
that neither stamps nor arrives with a surviving source IP lands
unenriched — no `k8s.*` attributes, empty nearby-join keys, no error
anywhere.

## What `config.yaml` assumes of its DaemonSet (the T4 hand-off)

The config is the whole distro, so everything else it needs is the
deployment's job. A DaemonSet running this file must provide:

- **A ServiceAccount** whose ClusterRole grants `get`, `list` and `watch` on
  `pods` and `namespaces` cluster-wide — `k8s_attributes` uses
  `auth_type: serviceAccount` and watches the API to resolve pod identity.
  Nothing here reads labels or owner references, so `replicasets` is *not*
  needed; adding it later is what widens this rule, not a chart preference.
- **`/var/log/pods` mounted read-only** from the host. On containerd nodes
  the files there are real files; where they are symlinks into
  `/var/lib/docker/containers`, that directory must be mounted read-only
  too or the tail resolves to nothing.
- **`OBSTACK_COLLECTOR_API_KEY`** from a Secret (never a values literal —
  see above) and **`OBSTACK_INGEST_ENDPOINT`** pointing at the ingest
  Service's OTLP/HTTP port.
- **`OBSTACK_COLLECTOR_EXCLUDE_CONTAINER`** set to the instrumented
  container's name (D37.3). Without it the collector tails that container
  too and its lines land twice.
- **A writable, persistent directory for `file_storage`** — a per-node
  `hostPath` (e.g. `/var/lib/obstack-collector`, matched by
  `OBSTACK_COLLECTOR_STORAGE_DIR` if a different path is used), not an
  `emptyDir`. It must survive the collector's own pod restarts, or every
  restart re-ships every historical line — see Checkpointing below. Compose
  satisfies the same contract with the `collector-storage` named volume in
  `docker-compose.yml`.
- **A liveness/readiness probe against `:13133`**, which is why the
  `health_check` extension binds `0.0.0.0` rather than its localhost
  default.
- **The pod's own OTLP endpoints, `:4317`/`:4318`**, reachable by the apps
  that route through it.

## Cluster events (Kubernetes only)

Neither config in this directory ships Kubernetes `Event` objects —
`FailedScheduling`, a failed image pull, `Unhealthy` from a probe, the
`Killing` after an OOM. They are not in `config.yaml` on purpose. The
`k8s_events` receiver watches the API server rather than the node it runs
on, so a DaemonSet running it would deliver the whole cluster's event stream
once per node; that is a duplicate of the same family as D37.3's, and it
takes the same answer — emit it once, don't deduplicate later.

The chart therefore runs events in a **separate single-replica Deployment**
with its own config, `deploy/helm/obstack/files/collector-events-config.yaml`
(`templates/collector/events-deployment.yaml`, gated on
`collector.k8sEvents.enabled`, default on). That config runs one receiver
into `batch` into the same bearer-key `otlp_http` export these files use, so
events arrive at ingest as OTLP log records and land in `obstack.logs`. It
reuses this collector's ServiceAccount, which is why the chart's ClusterRole
grows `get`/`list`/`watch` on core `events` behind the same flag — a
widening for `k8s_events`, not for `k8s_attributes`, whose extract set is
unchanged, and `replicasets` stays absent as stated above.

It carries no `file_storage`: a watch has no byte offset to checkpoint, so
events during a restart are not backfilled — an honest gap, and a cheap one
against records the API server itself expires within the hour. Compose gets
none of this, for the reason its header already gives: no API server to
watch. `deploy/helm/obstack/README.md`, "The cluster-events collector", is
the fuller account.

## Checkpointing (`file_storage`) — the second duplicate door

D37.3's exclusion decides *which containers* filelog reads; it says nothing
about *which lines of an included file were already shipped*. Without a
checkpoint, `start_at: beginning` means every collector restart re-reads
every matched file from its first byte and re-ships every line it already
sent — a duplicate the exclusion cannot cover, because the container was
never excluded in the first place. The `file_storage` extension persists
each tailed file's read offset to `OBSTACK_COLLECTOR_STORAGE_DIR` (default
`/var/lib/obstack-collector`), referenced by `file_log`'s `storage:` field,
so a restart resumes instead of starting over. Both config files declare
this identically — same extension block, same env var, same default
directory — because the mechanism does not change between topologies, only
what backs the directory does: T4's per-node `hostPath` vs. Compose's
`collector-storage` named volume.

### Falsification probe

Proven both directions — a restart does not re-ship with the checkpoint in
place, and does re-ship without it — not by reading the config and trusting
the extension does what its name says:

```bash
# with file_storage wired (the shipped config): five ClickHouse startup
# lines land once.
bash deploy/collector/up.sh
docker exec obstack-clickhouse clickhouse-client --user obstack_web --password obstack_web_dev \
  --query "SELECT count() FROM obstack.logs WHERE service = ''"
# -> 5

# restart the collector mid-tail — nothing else touched.
docker compose -f deploy/compose/docker-compose.yml --profile collector restart collector
docker exec obstack-clickhouse clickhouse-client --user obstack_web --password obstack_web_dev \
  --query "SELECT count() FROM obstack.logs WHERE service = ''"
# -> 5, unchanged. The collector's own logs confirm why:
docker logs obstack-collector 2>&1 | grep "Resuming from previously known offset"
```

Without the checkpoint, the same restart re-ships every line that file
holds: a one-off container built from `config.compose.yaml` with its
`storage: file_storage` line removed logs no "Resuming…" line on restart,
and the count above gains the file's five lines again on every start
(5 → 10 → 15) — proven by hand against an isolated
project (`docker compose -p <name> ... down -v` first is safe there; it is
never safe against a stack this repo's tooling did not start).

## Bring-up

```bash
bash deploy/collector/up.sh
```

Not a bare `docker compose --profile collector up`: the script brings up
`clickhouse`, `ingest` and `demo` first, resolves the container IDs `include`
and `exclude` need, and only then starts `collector` with them wired — see
the script's own header for why the ordering matters. `docker compose
down -v` first if the stack has been up across a schema change (same rule as
`smoke.sh`).

The default `demo → ingest` path (`docker compose --profile demo up`) and
`smoke.sh` are untouched by any of this (D39/Q2): the collector is a second,
opt-in route, not a replacement for the signed one.
