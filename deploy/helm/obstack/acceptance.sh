#!/usr/bin/env bash
# The S2.2 exit criterion in one command (D35/D37): build this repo's two
# images, load every pinned image into a kind cluster, install the REAL chart
# (Helm is the only kind path — D35), drive POST /chat at the demo app, and
# assert the D37 evidence bundle through the D17 tsx facade harness
# (acceptance.ts) against the cluster's ClickHouse. Then the T1-escalation
# rider: restart the collector DaemonSet and prove previously-shipped lines
# are NOT re-shipped (file_storage checkpointing), and the D38(e) rider: a
# collector-routed event-form GenAI fixture lands with prompt/completion
# filled.
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
images="$(helm template "$RELEASE" "$chart_dir" | sed -n 's/^ *image: *//p' | tr -d '"' | sort -u)"
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
  helm upgrade "$RELEASE" "$chart_dir" --reset-values --set "web.betterAuthSecret=$WEB_AUTH_SECRET" --wait --timeout "$UPGRADE_TIMEOUT"
else
  step "installing release '$RELEASE'"
  helm install "$RELEASE" "$chart_dir" --set "web.betterAuthSecret=$WEB_AUTH_SECRET" --wait --timeout "$INSTALL_TIMEOUT"
fi

step "port-forwarding clickhouse + demo + web"
port_forward "svc/$RELEASE-clickhouse" "$CLICKHOUSE_PORT:8123" "http://127.0.0.1:$CLICKHOUSE_PORT/ping"
port_forward "svc/$RELEASE-demo" "$DEMO_PORT:8000" "http://127.0.0.1:$DEMO_PORT/healthz"
# T5: the web workload serves from the loaded live-stamped image — /login for
# the same reason the compose healthcheck picks it (renders in every mode,
# needs no session). A probe answering here means the boot check passed: the
# stamp matched and the release's BETTER_AUTH_SECRET reached the pod.
port_forward "svc/$RELEASE-web" "$WEB_PORT:3000" "http://127.0.0.1:$WEB_PORT/login"

step "firing the demo agent"
trace_1="$(chat 'why did checkout start failing')"
printf '   trace_id=%s\n' "$trace_1"

step "asserting the D37 evidence bundle (four layers, SOLID, NEARBY, zero duplicated bodies)"
harness assert "$trace_1"

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

printf '\nacceptance: PASS (stack-on-kind, %ss)\n' "$SECONDS"
