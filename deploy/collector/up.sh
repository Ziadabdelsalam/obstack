#!/usr/bin/env bash
# Brings up the compose stack with the collector profile active (D39/Q2).
#
#   bash deploy/collector/up.sh
#
# Why not a bare `docker compose --profile collector up`: filelog's include
# and exclude (D37.3, config.compose.yaml) are both scoped by Docker
# container ID, and an ID does not exist before the container does. So this
# script brings the base stack up first, resolves the two IDs it needs, and
# only then starts the collector with them set. A collector started without
# that step still runs; it just tails nothing (both env vars default to a
# sentinel that matches no file) — see README.md's falsification probe for
# what removing only the exclusion, rather than both, demonstrates.
set -euo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../compose" && pwd)"
compose=(docker compose -f "$compose_dir/docker-compose.yml" --profile collector)

HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'collector up: %s\n' "$1" >&2; exit 1; }

step "booting clickhouse + ingest + demo"
"${compose[@]}" up -d --build clickhouse ingest demo

step "waiting for healthy containers"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until [ -z "$("${compose[@]}" ps --format '{{.Health}}' | grep -v '^healthy$' || true)" ]; do
  [ "$SECONDS" -lt "$deadline" ] || {
    "${compose[@]}" ps
    fail "containers not healthy after ${HEALTH_TIMEOUT_S}s"
  }
  sleep 2
done

clickhouse_id="$(docker inspect --format '{{.Id}}' obstack-clickhouse)"
demo_id="$(docker inspect --format '{{.Id}}' obstack-demo-agent)"
step "resolved obstack-clickhouse ${clickhouse_id:0:12} (tailed) and obstack-demo-agent ${demo_id:0:12} (tailed, then excluded — it already ships via OTLP)"
export OBSTACK_COLLECTOR_TAIL_CONTAINER_ID="$clickhouse_id"
export OBSTACK_COLLECTOR_EXCLUDE_CONTAINER_ID="$demo_id"

step "starting the collector"
"${compose[@]}" up -d collector

step "waiting for the collector's health_check extension"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until curl -fsS -o /dev/null http://127.0.0.1:13133/; do
  [ "$SECONDS" -lt "$deadline" ] || fail "collector health_check not answering after ${HEALTH_TIMEOUT_S}s"
  sleep 2
done

printf '\ncollector up: OTLP/gRPC 127.0.0.1:5317, OTLP/HTTP 127.0.0.1:5318\n'
