#!/usr/bin/env bash
# The S2.3 exit criterion in one command (T5): both wired surfaces searching
# real ingested data, on a stack built from nothing.
#
#   bash deploy/compose/exit-evidence.sh
#
# It destroys the compose volumes first — this is the evidence run, so it starts
# from nothing on purpose — then: re-proves M1's smoke path, seeds a dedicated
# workspace whose exact shape is known (deploy/compose/exit-seed.mjs), counts
# that workspace IN CLICKHOUSE so every "N of M" the UI claims is checked
# against a denominator the app did not produce (D71(b)), serves the real
# production build against it, and asserts:
#
#   - the traces list: total, pagination, and free text reaching a token that
#     exists ONLY in a span prompt and one that exists ONLY in a log body;
#   - /app/logs: filters, the cap+1 truncation marker, the real empty state,
#     and the D42 carrier row rendered by nothing and matched by nothing;
#   - neither wired surface carrying a SAMPLE badge, with an unwired route as
#     the positive control that the badge still exists at all;
#   - the adversarial URL matrix (D66/D68/D73) answering 200 with default bounds;
#   - and, in a real browser, everything a server render cannot show
#     (deploy/compose/exit-browser.mjs).
#
# Prerequisites: docker, node, npm ci at the repo root, and Google Chrome for
# the browser section (skipped with a stated reason if it is absent).
set -uo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$compose_dir/../.." && pwd)"
compose=(docker compose -f "$compose_dir/docker-compose.yml" --profile demo)

WORKSPACE="${OBSTACK_WORKSPACE_ID:-ws_s23_exit}"
APP_PORT="${APP_PORT:-3210}"
CDP_PORT="${CDP_PORT:-9333}"
CH="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"
BASE="http://127.0.0.1:$APP_PORT"
OUT="${OUT_DIR:-$(mktemp -d)}"

pass=0; fail=0
step() { printf '\n== %s\n' "$1"; }
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  FAIL %s — %s\n' "$1" "$2"; fail=$((fail + 1)); }
claim() { # claim <description> <condition-exit-code> <detail>
  if [ "$2" = 0 ]; then ok "$1"; else no "$1" "$3"; fi
}

# Query ClickHouse as the read-only web user — the same grant the app has, but
# our own SQL, so the denominators below are independent of the app's queries.
q() { curl -s "$CH/?user=obstack_web&password=obstack_web_dev" --data-binary "$1"; }
# React splits text nodes with <!-- -->; strip them so a human-readable string
# can be matched the way a human reads it.
page() { curl -s "$BASE$1" | sed 's/<!-- -->//g'; }
# -a because a hostile URL can put a NUL byte in the response, and grep would
# otherwise call the page binary and match nothing — a guard that passes by
# refusing to look is the hollow kind (S2.0 L1).
rows_in() { grep -oa "$2" <<<"$1" | wc -l | tr -d ' '; }
has() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }

# Kill a process AND its descendants. `next start` runs under `npm exec`, so
# killing the subshell this script launched leaves the server itself listening —
# measured: the next run of this command then binds nothing (EADDRINUSE, into a
# log nobody reads), asserts against the STALE server, and prints PASS.
kill_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null
  return 0
}
cleanup() {
  kill_tree "${app_pid:-}"
  kill_tree "${chrome_pid:-}"
  return 0
}
trap cleanup EXIT

step "clean volumes (this run starts from nothing)"
"${compose[@]}" down -v >/dev/null 2>&1
printf '   compose volumes removed\n'

step "M1's signed smoke path, from clean volumes (regression floor)"
if bash "$compose_dir/smoke.sh" > "$OUT/smoke.log" 2>&1; then
  ok "smoke.sh PASS ($(grep -c . "$OUT/smoke.log") lines, $OUT/smoke.log)"
else
  no "smoke.sh" "see $OUT/smoke.log"
fi

step "seeding the evidence workspace"
OBSTACK_WORKSPACE_ID="$WORKSPACE" node "$compose_dir/exit-seed.mjs" | tee "$OUT/seed.json"

step "counting that workspace in ClickHouse (the independent denominator)"
TOTAL=$(q "SELECT countDistinct(trace_id) FROM obstack.trace_summaries WHERE workspace_id='$WORKSPACE'")
PHANTOMS=$(q "SELECT count() FROM obstack.trace_summaries WHERE workspace_id='$WORKSPACE' AND trace_id=''")
# `services` and `error_count` are SimpleAggregateFunction columns, so plain
# combinators, under the mandatory GROUP BY (D7's query rule).
SERVICE_TOTAL=$(q "SELECT count() FROM (SELECT trace_id FROM obstack.trace_summaries WHERE workspace_id='$WORKSPACE' GROUP BY workspace_id, trace_id HAVING has(groupUniqArrayArray(services), 'exit-agent'))")
ERROR_TOTAL=$(q "SELECT count() FROM (SELECT trace_id FROM obstack.trace_summaries WHERE workspace_id='$WORKSPACE' GROUP BY workspace_id, trace_id HAVING sum(error_count) > 0)")
DBPOD_ERROR_ROWS=$(q "SELECT count() FROM obstack.logs WHERE workspace_id='$WORKSPACE' AND k8s_pod='exit-db-0' AND severity_number >= 17 AND body != ''")
RENDERABLE_LOGS=$(q "SELECT count() FROM obstack.logs WHERE workspace_id='$WORKSPACE' AND body != ''")
printf '   traces=%s phantom(trace_id="")=%s service[exit-agent]=%s error=%s renderable_logs=%s db-pod error rows=%s\n' \
  "$TOTAL" "$PHANTOMS" "$SERVICE_TOTAL" "$ERROR_TOTAL" "$RENDERABLE_LOGS" "$DBPOD_ERROR_ROWS"
claim "the seed holds more traces than one page (the total is about data, not the cap)" "$([ "$TOTAL" -gt 200 ] && echo 0 || echo 1)" "$TOTAL"
claim "no P13-class phantom summary exists in the evidence workspace (D71(b))" "$([ "$PHANTOMS" = 0 ] && echo 0 || echo 1)" "$PHANTOMS found"

step "serving the production build against it"
# Refuse to assert against a server this run did not start. Every claim below
# reads HTTP from $BASE and cannot tell one server from another, so a leftover
# one answers for the build it was started with — and the badge decision is baked
# at BUILD time (see below), which is exactly the thing these claims measure.
if curl -s -m 2 -o /dev/null "$BASE/app/traces"; then
  no "port $APP_PORT is free for this run's own server" \
    "something already answers on $BASE — stop it (kill \$(lsof -ti tcp:$APP_PORT)) or set APP_PORT=..."
  printf '\nexit-evidence: FAIL — refusing to measure a server this run did not start\n'
  exit 1
fi
# Built with the SAME env it is served with, which is not a detail: the app
# layout reads the mode at render time, and a statically prerendered route bakes
# that decision at BUILD time — so a mock-mode build served live would ship
# unwired pages with no SAMPLE badge (measured while writing this harness).
( cd "$repo_root/apps/web" && OBSTACK_DATA_MODE=live CLICKHOUSE_URL="$CH" \
    CLICKHOUSE_USER=obstack_web CLICKHOUSE_PASSWORD=obstack_web_dev \
    OBSTACK_WORKSPACE_ID="$WORKSPACE" npx next build > "$OUT/build.log" 2>&1 ) \
  || { no "next build" "see $OUT/build.log"; exit 1; }
( cd "$repo_root/apps/web" && OBSTACK_DATA_MODE=live CLICKHOUSE_URL="$CH" \
    CLICKHOUSE_USER=obstack_web CLICKHOUSE_PASSWORD=obstack_web_dev \
    OBSTACK_WORKSPACE_ID="$WORKSPACE" npx next start -p "$APP_PORT" > "$OUT/app.log" 2>&1 ) &
app_pid=$!
curl -s --retry 40 --retry-delay 1 --retry-connrefused -o /dev/null "$BASE/app/traces"
printf '   %s (live, workspace %s, logs at %s)\n' "$BASE" "$WORKSPACE" "$OUT/app.log"

step "the traces list: a real total, a real page 2, free text that reaches"
html=$(page "/app/traces")
claim "header states the counted total" "$(has "$html" "200 of $TOTAL traces" && echo 0 || echo 1)" "$(grep -oa 'last [0-9]*h · [0-9]* of [0-9]* traces' <<<"$html" | head -1)"
claim "page 1 renders exactly one page of rows" "$([ "$(rows_in "$html" 'href="/app/traces/')" = 200 ] && echo 0 || echo 1)" "$(rows_in "$html" 'href="/app/traces/') rows"
claim "no SAMPLE badge on /app/traces in live mode" "$(has "$html" "SAMPLE DATA" && echo 1 || echo 0)" "badge present"

grep -oa 'href="/app/traces/[a-z0-9]*"' <<<"$html" | sort -u > "$OUT/page1.ids"
html2=$(page "/app/traces?page=2")
grep -oa 'href="/app/traces/[a-z0-9]*"' <<<"$html2" | sort -u > "$OUT/page2.ids"
claim "a deep link to page 2 renders page 2 server-side" "$(has "$html2" "page 2 of 2" && echo 0 || echo 1)" "no pager"
claim "page 2 carries the rest of the data, same total" "$(has "$html2" "$((TOTAL - 200)) of $TOTAL traces" && echo 0 || echo 1)" "$(grep -oa '[0-9]* of [0-9]* traces' <<<"$html2" | head -1)"
shared=$(comm -12 "$OUT/page1.ids" "$OUT/page2.ids" | wc -l | tr -d ' ')
claim "page 2 is disjoint from page 1" "$([ "$shared" = 0 ] && echo 0 || echo 1)" "$shared shared ids"

# The probe trace ids come from the seeder itself rather than being restated —
# a copy here could agree with a fixture that no longer exists.
seed_const() {
  SEED_MODULE="$compose_dir/exit-seed.mjs" SEED_KEY="$1" \
    node -e 'import(process.env.SEED_MODULE).then((m) => console.log(m[process.env.SEED_KEY]))'
}
prompt_trace=$(seed_const PROMPT_TRACE)
log_trace=$(seed_const LOG_TRACE)
carrier_trace=$(seed_const CARRIER_TRACE)

for probe in "zzpromptonlytoken:$prompt_trace:a span prompt" \
             "zzlogbodyonlytoken:$log_trace:a log body" \
             "zzcarrieronlytoken:$carrier_trace:a D42 carrier row"; do
  token="${probe%%:*}"; rest="${probe#*:}"; want="${rest%%:*}"; where="${rest##*:}"
  found=$(page "/app/traces?q=$token")
  hits=$(rows_in "$found" 'href="/app/traces/')
  claim "free text finds the trace whose token exists only in $where" \
    "$([ "$hits" = 1 ] && has "$found" "$want" && echo 0 || echo 1)" "$hits row(s)"
done

nothing=$(page "/app/traces?q=zznosuchtokenanywhere")
claim "a term that matches nothing is an empty result, not a fallback (D13)" \
  "$(has "$nothing" "No traces match these filters" && has "$nothing" "0 of 0 traces" && echo 0 || echo 1)" "not the empty state"

step "/app/logs: filtered, truncated honestly, and emptied to its real empty state"
logs=$(page "/app/logs")
claim "the header states what rendered and that more match (cap+1, D44)" \
  "$(has "$logs" "200 shown · more match · last 6h" && echo 0 || echo 1)" "$(grep -oa '[0-9]* shown[^<]*' <<<"$logs" | head -1)"
claim "no SAMPLE badge on /app/logs in live mode" "$(has "$logs" "SAMPLE DATA" && echo 1 || echo 0)" "badge present"
claim "the D42 carrier row does not render (empty body, D51(e))" "$(has "$logs" "zzcarrieronlytoken" && echo 1 || echo 0)" "carrier content rendered"

carrier_search=$(page "/app/logs?q=zzcarrieronlytoken")
claim "and it is not matchable here either — the reach is the body only" \
  "$(has "$carrier_search" "No log lines match" && echo 0 || echo 1)" "carrier matched on /app/logs"
body_search=$(page "/app/logs?q=zzlogbodyonlytoken")
claim "a body search narrows to exactly its row, and the count says so" \
  "$(has "$body_search" "1 shown · last 6h" && echo 0 || echo 1)" "$(grep -oa '[0-9]* shown[^<]*' <<<"$body_search" | head -1)"
empty=$(page "/app/logs?pod=no-such-pod-anywhere")
claim "an impossible filter renders the REAL empty state" \
  "$(has "$empty" "No log lines match" && has "$empty" "0 shown" && echo 0 || echo 1)" "not the empty state"
claim "and nothing from the mock stream appears in it" "$(has "$empty" "kafka-broker-2" && echo 1 || echo 0)" "mock pod names present"

step "the SAMPLE badge still exists (positive control — an unwired route)"
unwired=$(page "/app/costs")
claim "an unwired route still carries the badge, so its absence above is a fact" \
  "$(has "$unwired" "SAMPLE DATA" && echo 0 || echo 1)" "the badge is gone everywhere — the check above proves nothing"

step "adversarial URL matrix (D66/D68/D73)"
# The APPLIED bound is read out of the HEADER, never from the words "last 6h" —
# every range dropdown renders that as an option whatever was applied.
#
# Read byte-wise (LC_ALL=C) with an ASCII-only pattern, and both halves are
# load-bearing: `?q=%00` puts a NUL in the response, and under a UTF-8 locale a
# pattern containing the header's `·` then matches NOTHING — the check would
# report every NUL case as a failure while a broken bound reported the same
# thing, which is a guard that cannot tell the two apart (S2.2 L4, on this
# harness's own sweep). Measured here, not assumed.
bound_of() { # bound_of <route> <file>
  local pattern
  if [ "$1" = /app/traces ]; then pattern='last 6h[^<]*of [0-9]+ traces'; else pattern='[0-9]+ shown[^<]*last 6h'; fi
  sed 's/<!-- -->//g' "$2" | LC_ALL=C grep -oaE "$pattern" | head -1
}

matrix_fail=0; matrix_n=0
for route in /app/traces /app/logs; do
  # Positive control first: the reader finds the bound on an ordinary request,
  # so an empty result below is a missing bound and not a dead pattern.
  curl -s -o "$OUT/control.html" "$BASE$route"
  claim "the matrix can read $route's applied bound at all (positive control)" \
    "$([ -n "$(bound_of "$route" "$OUT/control.html")" ] && echo 0 || echo 1)" "pattern matches nothing on a clean page"

  if [ "$route" = /app/traces ]; then params="q status service model minMs minCost maxCost range page"; else params="q sev pod onTrace range"; fi
  for param in $params; do
    for value in toString constructor valueOf hasOwnProperty __proto__ 1e21 99999999999999999999 -5 NaN "%00" junk-value; do
      matrix_n=$((matrix_n + 1))
      body=$(curl -s -o "$OUT/m.html" -w '%{http_code}' "$BASE$route?$param=$value")
      bound=$(bound_of "$route" "$OUT/m.html")
      if [ "$body" != 200 ] || [ -z "$bound" ]; then
        printf '     %s?%s=%s -> HTTP %s bound=%s\n' "$route" "$param" "$value" "$body" "${bound:-MISSING}"
        matrix_fail=$((matrix_fail + 1))
      fi
    done
  done
done
claim "$matrix_n hostile URLs answer 200 with the default 6h bound" "$([ "$matrix_fail" = 0 ] && echo 0 || echo 1)" "$matrix_fail non-conforming"

step "the browser half (carry-forward 2 both surfaces, the late echo, saved views)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
# Same refusal as the app port, and it matters more here: a Chrome this run did
# not start keeps somebody else's profile, and "the saved view survived" would
# then be a claim about localStorage a previous run wrote. The fresh
# --user-data-dir below is only fresh if this is the browser we drive.
if curl -s -m 2 -o /dev/null "http://127.0.0.1:$CDP_PORT/json/version"; then
  no "CDP port $CDP_PORT is free for this run's own browser" \
    "a debuggable browser already answers there — its profile is not this run's; stop it or set CDP_PORT=..."
  printf '\nexit-evidence: FAIL — refusing to drive a browser this run did not start\n'
  exit 1
fi
if [ -x "$chrome" ]; then
  "$chrome" --headless=new --remote-debugging-port="$CDP_PORT" --user-data-dir="$OUT/chrome" \
    --no-first-run --no-default-browser-check about:blank > "$OUT/chrome.log" 2>&1 &
  chrome_pid=$!
  curl -s --retry 30 --retry-delay 1 --retry-connrefused -o /dev/null "http://127.0.0.1:$CDP_PORT/json/version"
  if APP="$BASE" CDP_PORT="$CDP_PORT" \
     EXPECT_TOTAL="$TOTAL" EXPECT_SERVICE_TOTAL="$SERVICE_TOTAL" EXPECT_ERROR_TOTAL="$ERROR_TOTAL" \
     EXPECT_DBPOD_ERROR_ROWS="$DBPOD_ERROR_ROWS" \
     node "$compose_dir/exit-browser.mjs" > "$OUT/browser.log" 2>&1; then
    grep -E '^(==|  ok|  FAIL)' "$OUT/browser.log"
    ok "browser evidence PASS (transcript: $OUT/browser.log)"
  else
    grep -E '^(==|  ok|  FAIL)' "$OUT/browser.log"
    no "browser evidence" "see $OUT/browser.log"
  fi
else
  no "browser evidence" "Chrome not found at '$chrome' — set CHROME=... (NOT REPRODUCED)"
fi

step "result"
printf '   %s passed, %s failed — artifacts in %s\n' "$pass" "$fail" "$OUT"
[ "$fail" = 0 ] || exit 1
printf '\nexit-evidence: PASS (%ss)\n' "$SECONDS"
