#!/usr/bin/env bash
# The Phase 1 exit criterion in one command (D16): boot the stack, fire the demo
# agent, and assert through the web facade that the trace lands whole — api,
# agent, tool and llm spans under one trace_id, with correlated logs.
#
#   bash deploy/compose/smoke.sh
#
# Migrations are tracked by filename, so a volume that predates a pre-release
# schema edit keeps the old tables: run `docker compose --profile demo down -v`
# first if the stack has been up across a schema change.
set -euo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$compose_dir/../.." && pwd)"
compose=(docker compose -f "$compose_dir/docker-compose.yml" --profile demo)

DEMO_URL="${DEMO_URL:-http://127.0.0.1:8000}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-180}"

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'smoke: %s\n' "$1" >&2; exit 1; }

step "booting clickhouse + ingest + demo"
"${compose[@]}" up -d --build

step "waiting for healthy containers"
deadline=$((SECONDS + HEALTH_TIMEOUT_S))
until [ -z "$("${compose[@]}" ps --format '{{.Health}}' | grep -v '^healthy$' || true)" ]; do
  [ "$SECONDS" -lt "$deadline" ] || {
    "${compose[@]}" ps
    fail "containers not healthy after ${HEALTH_TIMEOUT_S}s"
  }
  sleep 2
done

step "firing the demo agent"
response="$(curl -fsS -X POST "$DEMO_URL/chat" \
  -H 'content-type: application/json' \
  -d '{"message":"why did checkout start failing"}')" || fail "POST $DEMO_URL/chat failed"
trace_id="$(printf '%s' "$response" | grep -o '"trace_id":"[0-9a-f]\{32\}"' | head -1 | cut -d'"' -f4)"
[ -n "$trace_id" ] || fail "no trace_id in the /chat response: $response"
printf '   trace_id=%s\n' "$trace_id"

step "asserting through the web facade (OBSTACK_DATA_MODE=live)"
cd "$repo_root"
# Connection defaults live in smoke.ts (exported CLICKHOUSE_* still win).
# --tsconfig points tsx at the app's tsconfig (apps/web) so the `@/` paths it
# declares resolve smoke.ts's imports; smoke.ts itself stays in deploy/compose.
npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server deploy/compose/smoke.ts "$trace_id"
