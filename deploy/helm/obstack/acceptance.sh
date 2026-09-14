#!/usr/bin/env bash
# The S2.2 exit criterion in one command (D35/D37): build this repo's two
# images, load every pinned image into a kind cluster, install the REAL chart
# (Helm is the only kind path — D35), drive POST /chat at the demo app, and
# assert the D37 evidence bundle through the D17 tsx facade harness
# (acceptance.ts) against the cluster's ClickHouse. Then the T1-escalation
# rider: restart the collector DaemonSet and prove previously-shipped lines
# are NOT re-shipped (file_storage checkpointing), the D38(e) rider: a
# collector-routed event-form GenAI fixture lands with prompt/completion
# filled, and the S4.4 rider (last, because it deletes the demo pod): a live
# kubelet event on the pod that served a trace reaches that trace's
# `k8sEvents` through the facade. 0.7.0 (the pilot touchpoint) adds four
# riders: the chart's new values asserted on the rendered documents right after
# the budget (`acceptance.ts render`), an optional values OVERLAY so the
# pilot's shape runs through this same script (`ACCEPTANCE_VALUES`), the `/mcp`
# refusal through the chart's web Service, and — last, because it rolls
# ClickHouse — a real BACKUP onto the chart's optional backups disk.
#
# CI's `stack` job runs THIS script (S2.1 L3) — there is no CI-only sequence
# and no CI-only timeout arithmetic: the Helm timeouts below are the chart
# README's re-derived budget (900s cold install / 300s upgrade — see
# "--wait and --wait-for-jobs, precisely").
#
# Prerequisites (README.md, "Running the acceptance"):
#   - a kind cluster, current kubectl context (kind create cluster --name t5)
#   - npm ci run at the repo root (the harness runs via tsx)
#   - docker, kind, helm, kubectl, curl on PATH
#
#   bash deploy/helm/obstack/acceptance.sh
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$chart_dir/../../.." && pwd)"

RELEASE="${RELEASE:-obstack}"
# Local forward ports deliberately off the compose stack's 8123/8000, so a
# running compose stack on the same machine is never what this asserts against.
CLICKHOUSE_PORT="${CLICKHOUSE_PORT:-18123}"
DEMO_PORT="${DEMO_PORT:-18000}"
WEB_PORT="${WEB_PORT:-13000}"
# The one chart value with no default by design (D251(c)/D272: a committed
# cookie-signing secret in a distributable bundle is a shipped vulnerability),
# so this harness supplies a per-run one — exactly what a real operator does.
# Everything else stays chart defaults.
WEB_AUTH_SECRET="${WEB_AUTH_SECRET:-$(openssl rand -base64 32)}"
COLLECTOR_PORT="${COLLECTOR_PORT:-14318}"
# The chart README's budget: a cold install is the ClickHouse image pull plus
# seconds (the migrate Job's own activeDeadlineSeconds already contains the
# worst case); an upgrade's ClickHouse is warm, and 300s is also how long a
# broken migration takes to surface.
INSTALL_TIMEOUT=900s
UPGRADE_TIMEOUT=300s

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'acceptance: %s\n' "$1" >&2; exit 1; }

# 0.7.0: an optional values overlay for the whole run — the pilot's SHAPE
# (registry images, `pullPolicy: IfNotPresent`, a demo toggle) through the SAME
# script a default run takes, so what CI's `stack` dispatch rehearses is this
# file and not a CI-only sequence (S2.1 L3). Empty, the default, means chart
# defaults exactly as before: every helm call below expands to nothing extra.
# The `${arr[@]+"${arr[@]}"}` form is bash 3.2 (macOS) under `set -u`, where a
# bare empty-array expansion is an unbound-variable error.
ACCEPTANCE_VALUES="${ACCEPTANCE_VALUES:-}"
values_args=()
if [ -n "$ACCEPTANCE_VALUES" ]; then
  [ -f "$ACCEPTANCE_VALUES" ] || fail "ACCEPTANCE_VALUES=$ACCEPTANCE_VALUES is not a file"
  values_args=(-f "$ACCEPTANCE_VALUES")
  printf 'values overlay: %s\n' "$ACCEPTANCE_VALUES"
fi
# The chart's default ingest password (values.yaml) — the backups rider below
# runs its BACKUP as the product's own write user, which holds GRANT ALL on the
# database and therefore the BACKUP privilege.
CLICKHOUSE_INGEST_PASSWORD="${CLICKHOUSE_INGEST_PASSWORD:-obstack_ingest_dev}"

# The kind cluster behind the current kubectl context — never a guessed name,
# so `kind load` and `kubectl`/`helm` below always talk to the same cluster.
context="$(kubectl config current-context)" || fail "no current kubectl context — create a kind cluster first"
case "$context" in
  kind-*) cluster="${context#kind-}" ;;
  *) fail "current kubectl context is '$context', not a kind cluster (kind-<name>)" ;;
esac

forward_pids=()
cleanup() {
  for pid in "${forward_pids[@]:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

# port_forward <target> <local:remote> <curl probe args...>
port_forward() {
  local target="$1" ports="$2"
  shift 2
  kubectl port-forward "$target" "$ports" >/dev/null 2>&1 &
  forward_pids+=($!)
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "$@" 2>/dev/null && return 0
    sleep 1
  done
  fail "port-forward $target $ports did not answer its probe"
}

chat() { # chat <question> -> trace_id on stdout
  local response trace_id
  response="$(curl -fsS -X POST "http://127.0.0.1:$DEMO_PORT/chat" \
    -H 'content-type: application/json' \
    -d "{\"message\":\"$1\"}")" || fail "POST /chat failed"
  trace_id="$(printf '%s' "$response" | grep -o '"trace_id":"[0-9a-f]\{32\}"' | head -1 | cut -d'"' -f4)"
  [ -n "$trace_id" ] || fail "no trace_id in the /chat response: $response"
  printf '%s' "$trace_id"
}

# The harness runs the same way smoke.ts does: tsx resolves the app's `@/`
# paths from its tsconfig, --conditions react-server satisfies `server-only`.
harness() {
  (cd "$repo_root" && \
    CLICKHOUSE_URL="http://127.0.0.1:$CLICKHOUSE_PORT" \
    OBSTACK_COLLECTOR_OTLP_URL="http://127.0.0.1:$COLLECTOR_PORT" \
    npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
      deploy/helm/obstack/acceptance.ts "$@")
}

# FIRST, because it needs no cluster, no images and no install: the rendered
# chart's total CPU requests have to fit the node they will be scheduled on.
# Measured on PR #24's tip a541546 — the chart asked for 1070m on a 2-vCPU
# GitHub runner whose kube-system already reserves ~950m of 2000m, so
# obstack-clickhouse-0 (500m, scheduled last) sat Pending for fifteen minutes
# on `FailedScheduling: 0/1 nodes are available: 1 Insufficient cpu` and the
# only thing the `stack` job reported was `helm install --wait` timing out at
# 900s. That is a render-time fact wearing a fifteen-minute disguise; this step
# takes it off. README.md, "The node's CPU-request budget".
step "chart CPU-request budget"
harness budget ${values_args[@]+"${values_args[@]}"}

# 0.7.0: the chart's new values — the demo toggle, Explain's mode, the `/mcp`
# address under the web Ingress, the collector's key through a secretKeyRef,
# the optional backups disk — asserted on rendered documents for the same
# reason the budget runs first: fixed at render time, a second to ask, and a
# wrong shape here would otherwise surface as a pod that never authenticates
# or an env line the product prints wrong. README.md, "Upgrading to 0.7.0".
step "chart 0.7.0 render assertions"
harness render ${values_args[@]+"${values_args[@]}"}

step "building this repo's images"
docker build -t obstack-ingest:kind "$repo_root/services/ingest"
docker build -t obstack-demo-agent:kind "$repo_root/demo/agent-app"
# Root context (D251(a) — the workspace-aware Dockerfile), live-stamped
# (D267): the chart's web workload only ever runs the live variant. Skipped
# when the image already exists (advisor ruling on the first-runner numbers:
# this ~2min cold build inside the `stack` job pushed it from ~5m to 7m13s —
# structural, so CI pre-builds it with a layer cache and this script reuses
# it). The skip PRINTS what it reuses — created timestamp + mode label — so a
# stale local image is visible rather than silent; one script for human and
# CI, staleness stated (S2.1 L3). Delete the image to force a fresh build.
if docker image inspect obstack-web:kind >/dev/null 2>&1; then
  printf 'reusing obstack-web:kind (created %s, io.obstack.data-mode=%s)\n' \
    "$(docker image inspect obstack-web:kind --format '{{.Created}}')" \
    "$(docker image inspect obstack-web:kind --format '{{index .Config.Labels "io.obstack.data-mode"}}')"
else
  docker build -t obstack-web:kind -f "$repo_root/apps/web/Dockerfile" \
    --build-arg OBSTACK_DATA_MODE=live "$repo_root"
fi

# Side-load every image the chart renders into the kind node (pin source of
# truth stays values.yaml — the list is read out of the rendered chart, never
# repeated here). Sanctioned by the T5 rider as an optimization, NOT a
# correctness mechanism: without this block the node pulls the same pinned
# tags itself during `helm install`, inside the same 900s budget. The K5
# wall-clock number includes this block.
step "loading images into kind cluster '$cluster'"
images="$(helm template "$RELEASE" "$chart_dir" ${values_args[@]+"${values_args[@]}"} | sed -n 's/^ *image: *//p' | tr -d '"' | sort -u)"
for image in $images; do
  case "$image" in
    *:kind) ;; # built above, never pulled
    *) docker pull -q "$image" & ;;
  esac
done
wait
# One platform-scoped archive rather than `kind load docker-image`: Docker
# Desktop's containerd store keeps the full multi-platform index for pulled
# images, and `docker save` of that index feeds `ctr import` digests whose
# blobs were never pulled ("ctr: content digest ... not found"). Saving
# exactly the node's platform sidesteps it and changes nothing on a
# plain-Engine CI runner.
archive="$(mktemp)"
platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
# shellcheck disable=SC2086 — the image list is deliberately word-split
docker save --platform "$platform" -o "$archive" $images
kind load image-archive "$archive" --name "$cluster"
rm -f "$archive"

if helm status "$RELEASE" >/dev/null 2>&1; then
  step "upgrading release '$RELEASE' (already installed — pre-upgrade hook path)"
  # --reset-values because Helm v4 reuses the last release's user-supplied
  # values when none are given (measured in T4's review, and again here: a
  # release last installed with `--set collector.excludeContainer=…` for a
  # probe silently keeps that value across a bare `helm upgrade`). This script
  # asserts the chart's DEFAULTS, so the upgrade path must start from them —
  # otherwise a re-run after a probe asserts a configuration nobody chose.
  helm upgrade "$RELEASE" "$chart_dir" --reset-values --set "web.betterAuthSecret=$WEB_AUTH_SECRET" ${values_args[@]+"${values_args[@]}"} --wait --timeout "$UPGRADE_TIMEOUT"
else
  step "installing release '$RELEASE'"
  helm install "$RELEASE" "$chart_dir" --set "web.betterAuthSecret=$WEB_AUTH_SECRET" ${values_args[@]+"${values_args[@]}"} --wait --timeout "$INSTALL_TIMEOUT"
fi

step "port-forwarding clickhouse + demo + web"
port_forward "svc/$RELEASE-clickhouse" "$CLICKHOUSE_PORT:8123" "http://127.0.0.1:$CLICKHOUSE_PORT/ping"
port_forward "svc/$RELEASE-demo" "$DEMO_PORT:8000" "http://127.0.0.1:$DEMO_PORT/healthz"
# T5: the web workload serves from the loaded live-stamped image — /login for
# the same reason the compose healthcheck picks it (renders in every mode,
# needs no session). A probe answering here means the boot check passed: the
# stamp matched and the release's BETTER_AUTH_SECRET reached the pod.
port_forward "svc/$RELEASE-web" "$WEB_PORT:3000" "http://127.0.0.1:$WEB_PORT/login"

# 0.7.0 (S8.1 D642 through the chart): `/mcp` is served by this release's web
# Service — the one probe a browserless harness can make is the endpoint's
# uniform refusal: no bearer, one bodiless 401 with the challenge header. A
# read key needs a signup, which the compose e2e drive owns; the claim here is
# "the path exists behind the chart and refuses correctly", nothing more.
step "0.7.0: /mcp answers through the chart's web Service (401 + challenge, no key)"
mcp_headers="$(curl -s -o /dev/null -D - -X POST "http://127.0.0.1:$WEB_PORT/mcp" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{}')"
printf '%s' "$mcp_headers" | head -1 | grep -q ' 401' \
  || fail "POST /mcp without a key did not answer 401: $(printf '%s' "$mcp_headers" | head -1)"
printf '%s' "$mcp_headers" | tr -d '\r' | grep -qi '^www-authenticate: Bearer realm="obstack"$' \
  || fail "the 401 carried no WWW-Authenticate: Bearer realm=\"obstack\" challenge"
printf '   401 with WWW-Authenticate: Bearer realm="obstack"\n'

step "firing the demo agent"
trace_1="$(chat 'why did checkout start failing')"
printf '   trace_id=%s\n' "$trace_1"

step "asserting the D37 evidence bundle (four layers, SOLID, NEARBY, zero duplicated bodies)"
harness assert "$trace_1"

# S6.4 (D466/D474): the ONLY place the collector→store k8s metrics path is
# proven on a real kubelet and API server — `validate` cannot enumerate the
# four dynamic k8s_cluster names, and the compose drive's cluster is a
# fixture. The harness polls `queryInfraSnapshot` (the module `/app/infra`
# renders from) until both receiver legs are fresh, then asserts a real node,
# the demo pod's summed limits (D457), the D450 name-set subset and D458's
# negative. Placed here, before the restart rider, so the snapshot describes
# the collector pods that have been scraping since install rather than ones
# rolled seconds ago.
step "S6.4: the collector's k8s metrics reach the store through the real module (D450/D466)"
kubectl rollout status "deployment/$RELEASE-collector-cluster" --timeout=180s
demo_pod_now="$(kubectl get pod \
  -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=demo" \
  -o jsonpath='{.items[0].metadata.name}')"
[ -n "$demo_pod_now" ] || fail "no demo pod found for release '$RELEASE'"
harness k8s-metrics "$demo_pod_now"
# D454: the widened ClusterRole is SUFFICIENT, asserted as an absence — a
# cluster receiver missing a grant does not crash, it logs watch/list failures
# forever and emits partial data, which is exactly the silent shape this grep
# turns red.
forbidden_lines="$(kubectl logs "deploy/$RELEASE-collector-cluster" | grep -cE 'forbidden|Failed to watch|Failed to list' || true)"
if [ "$forbidden_lines" != "0" ]; then
  kubectl logs "deploy/$RELEASE-collector-cluster" | grep -E 'forbidden|Failed to watch|Failed to list' | head -5 >&2
  fail "the cluster collector logs $forbidden_lines RBAC failure line(s) — the D454 ClusterRole is missing a grant"
fi
printf '   D454: zero forbidden/Failed-to-watch/Failed-to-list lines in the cluster collector log\n'

# T1 review escalation rider: file_storage checkpointing means a collector
# restart resumes each tailed file instead of re-reading it from the top —
# without it, every previously-shipped line would land a second time with its
# original timestamp, which is exactly the duplicate shape the harness's
# (atMs, body) check turns red on. The second /chat proves the restarted
# pipeline is live end-to-end (its own solid AND nearby rows arrive through
# the new collector pod) before the first trace is re-checked, so "no
# duplicates" is an observation about a working pipeline, not about silence.
step "collector restart: previously-shipped lines are not re-shipped"
kubectl rollout restart "daemonset/$RELEASE-collector"
kubectl rollout status "daemonset/$RELEASE-collector" --timeout=180s
trace_2="$(chat 'which service is burning the most tokens today')"
printf '   trace_id=%s\n' "$trace_2"
harness assert "$trace_2"
harness assert "$trace_1"

step "D38(e): collector-routed event-form GenAI fixture"
# Probe with an empty OTLP request — the receiver answers 200 to `{}`; a bare
# GET would 404 and say nothing about readiness.
port_forward "ds/$RELEASE-collector" "$COLLECTOR_PORT:4318" \
  -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:$COLLECTOR_PORT/v1/logs"
harness genai-fixture

# S4.4 cluster-events rider — LAST on purpose: it deletes the demo pod, so
# every check above must already have run against the pod that served them.
#
# The product claims "k8s events on the timeline". This proves it on a live
# cluster instead of describing it: the chart's cluster collector
# (templates/collector/cluster-deployment.yaml — a single-replica Deployment,
# because both of its receivers read the cluster-wide API) is asserted
# Available first, then a fresh trace is driven and the pod that served it is
# deleted.
# The kubelet emits a `Killing` event against exactly that Pod — a Normal-Type
# event, which EVENT_KINDS (apps/web/src/server/adapters.ts) folds to kind
# "restart" at severity "info" — and the harness reads it back through the same
# facade the trace detail page renders from.
#
# Idempotent with the cleanup trap and with a re-run: the demo Deployment
# recreates the pod, and the port-forwards this rider invalidates (the demo
# Service's endpoint goes away with the pod) are the trap's to kill anyway,
# because nothing after this line drives the demo again.
step "S4.4: a live kubelet event lands on the trace's timeline"
kubectl rollout status "deployment/$RELEASE-collector-cluster" --timeout=180s
# By the chart's own labels, never a guessed name — demo replicas is 1
# (templates/demo/deployment.yaml says why), so this IS the pod serving /chat.
demo_pod="$(kubectl get pod \
  -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=demo" \
  -o jsonpath='{.items[0].metadata.name}')"
[ -n "$demo_pod" ] || fail "no demo pod found for release '$RELEASE'"
trace_3="$(chat 'what changed right before the error rate spiked')"
printf '   trace_id=%s pod=%s\n' "$trace_3" "$demo_pod"
# One full BatchSpanProcessor interval before the pod stops existing:
# OTEL_BSP_SCHEDULE_DELAY is 1000ms (templates/demo/deployment.yaml), and the
# trace's spans have to be OUT of the pod for K8S_EVENTS_SQL to have any
# (namespace, pod) pair to match the event against. Two seconds also keeps the
# `Killing` event comfortably inside the ±10s nearby window
# (apps/web/src/lib/nearby-logs.ts) it is joined on, rather than at its edge.
sleep 2
kubectl delete pod "$demo_pod" --wait=false
harness events "$trace_3" "$demo_pod"

# 0.7.0 (pilot packet D696): the optional backups disk takes a real BACKUP.
# Last, after the S4.4 rider, because enabling it rolls the ClickHouse pod
# (config.d is read at boot) and every claim above must already have run
# against the stores as installed. `--reset-values` keeps every other value
# at its default (the upgrade path above says why), so the one thing that
# changes is the flag under test; the release is left with it on, and a
# re-run's own `--reset-values` upgrade puts it back. The BACKUP runs as the
# product's write user (GRANT ALL ON obstack.* — files/obstack-users.xml),
# and `BACKUP_CREATED` is ClickHouse's own word for a finished archive. A
# synchronous BACKUP answers with its id and that status as its own result
# row, which is where this reads it: `system.backups` would say the same, but
# reading it needs `SELECT ON system.backups`, a grant the product's write
# user does not hold and should not gain for a rider (measured on the first
# live run — the archive was already on the volume when the status read was
# refused).
step "0.7.0: the ClickHouse backups disk accepts a BACKUP"
helm upgrade "$RELEASE" "$chart_dir" --reset-values --set "web.betterAuthSecret=$WEB_AUTH_SECRET" \
  --set clickhouse.backups.enabled=true ${values_args[@]+"${values_args[@]}"} --wait --timeout "$UPGRADE_TIMEOUT"
kubectl rollout status "statefulset/$RELEASE-clickhouse" --timeout=180s
backup_name="acceptance-$(date -u +%Y%m%dT%H%M%SZ).zip"
backup_row="$(kubectl exec "statefulset/$RELEASE-clickhouse" -- clickhouse-client \
  --user obstack_ingest --password "$CLICKHOUSE_INGEST_PASSWORD" \
  --query "BACKUP DATABASE obstack TO Disk('backups', '$backup_name')")"
backup_id="$(printf '%s' "$backup_row" | cut -f1)"
backup_status="$(printf '%s' "$backup_row" | cut -f2)"
[ -n "$backup_id" ] || fail "BACKUP DATABASE obstack returned no id: '$backup_row'"
[ "$backup_status" = "BACKUP_CREATED" ] || fail "backup $backup_id is '$backup_status', not BACKUP_CREATED"
backup_bytes="$(kubectl exec "statefulset/$RELEASE-clickhouse" -- sh -c "stat -c %s /var/lib/clickhouse/backups/$backup_name")"
[ "${backup_bytes:-0}" -gt 0 ] || fail "backup archive /var/lib/clickhouse/backups/$backup_name is missing or empty"
printf '   %s: BACKUP_CREATED, %s bytes on the data volume\n' "$backup_name" "$backup_bytes"

printf '\nacceptance: PASS (stack-on-kind, %ss)\n' "$SECONDS"
