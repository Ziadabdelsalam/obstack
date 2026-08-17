#!/usr/bin/env bash
# The S2.4 exit criterion in one command (T5/D80): two sample apps instrumented
# with nothing but an obstack SDK install and the documented two lines, each
# landing the same four-layer trace with the D8 GenAI attributes.
#
#   bash deploy/compose/sdk-evidence.sh
#
# This is also exactly what CI's `sdk-e2e` job runs — one definition of the
# evidence, and the command a human is told to run is the command that runs in
# CI (S2.1 L3). It destroys the compose volumes first, because it is the
# evidence run and starting from nothing is the point, then proves, in order:
#
#   - both samples land ONE trace of >= 4 spans with layers api/agent/tool/llm
#     and the full D8 attribute set, asserted in SQL against ClickHouse;
#   - prompt and completion live in the dedicated columns, and the attributes
#     Map holds neither the two keys NOR the content under any other key —
#     D92's two-part assertion, each half with a positive control so an absence
#     cannot be a mistyped token;
#   - both traces render through the shipped query layer (deploy/compose/
#     sdk-checks.ts, the D17 facade the product itself reads from);
#   - standard OTLP on the wire: each sample once against the stock upstream
#     collector image with a file exporter, its output asserted to carry the
#     sample's span names and gen_ai.* attributes — the exit clause's "any OTLP
#     endpoint", measured rather than described;
#   - fail open: each sample against a dead endpoint still answers 200, and
#     nothing of that run reaches ClickHouse;
#   - the D15 regression floor: demo/agent-app/ is untouched.
#
# Process ownership (S2.3 L4): every port this run uses is checked free BEFORE
# anything starts, and every container it drives is one it named and started
# itself. A harness that measured a server somebody else left running would be
# reporting on a build it never made.
#
# Prerequisites: docker, node, and `npm ci` at the repo root (sdk-checks.ts runs
# the app's own server modules through tsx).
#
# `OUT_DIR=<dir>` puts the run's artifacts — the collector dumps, the sample
# answers, the sdk-checks log — somewhere durable instead of a temp directory.
# It changes where output lands, never what is asserted; the CI job sets it so a
# red run can be read afterwards.
set -uo pipefail

compose_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$compose_dir/../.." && pwd)"
compose=(docker compose -f "$compose_dir/docker-compose.yml" --profile sdk)

CH="${CLICKHOUSE_URL:-http://127.0.0.1:8123}"
HEALTH_TIMEOUT_S="${HEALTH_TIMEOUT_S:-240}"
ARRIVAL_TIMEOUT_S="${ARRIVAL_TIMEOUT_S:-60}"
OUT="${OUT_DIR:-$(mktemp -d)}"
mkdir -p "$OUT" || { printf 'sdk-evidence: FAIL — cannot create OUT_DIR %s\n' "$OUT"; exit 1; }

# The ports: the two the compose services publish (each sample's README runs it
# on the same one), plus one per one-off probe container so a probe never
# collides with the sample it is a variant of.
PY_PORT=8010
TS_PORT=8100
PY_FAILOPEN_PORT=8011
TS_FAILOPEN_PORT=8101
PY_OTLP_PORT=8012
TS_OTLP_PORT=8102

# The stock upstream collector, pinned to the same image tag the repo already
# runs (deploy/compose/docker-compose.yml's collector service, D14 unmodified
# upstream). Nothing under deploy/collector/ is read or edited: the config for
# this leg is written fresh into $OUT below, because the point is a collector
# that knows nothing about obstack.
OTLP_IMAGE="otel/opentelemetry-collector-k8s:0.158.0"
OTLP_PROBE=obstack-sdk-otlp-probe
OTLP_VOLUME=obstack-sdk-otlp-out

# The deterministic content each sample's fake produces. Both fakes are pure
# functions of the request, so these are equalities and not shapes — which is
# what makes D92's value-absence half assertable at all: a token that provably
# EXISTS in the prompt/completion columns and provably does NOT appear in any
# attributes Map value is a fact about the strip, not about a typo.
PY_PROMPT_TOKEN='obstack sample agent'
PY_COMPLETION_TOKEN='Based on the retrieved facts'
TS_PROMPT_TOKEN='obstack sample agent'
TS_COMPLETION_TOKEN='not automatically a slow model'

pass=0; fail=0
step() { printf '\n== %s\n' "$1"; }
ok()   { printf '  ok   %s\n' "$1"; pass=$((pass + 1)); }
no()   { printf '  FAIL %s — %s\n' "$1" "$2"; fail=$((fail + 1)); }
claim() { # claim <description> <condition-exit-code> <detail>
  if [ "$2" = 0 ]; then ok "$1"; else no "$1" "$3"; fi
}
refuse() { printf '\nsdk-evidence: FAIL — %s\n' "$1" >&2; exit 1; }

# ClickHouse as the read-only web user — the grant the app has, but this
# harness's own SQL, so nothing below depends on the app's queries being right.
q() { curl -s "$CH/?user=obstack_web&password=obstack_web_dev" --data-binary "$1"; }

# Wait until a URL answers, by polling. Not `curl --retry --retry-connrefused`:
# docker binds a published host port the moment the container is created, so a
# request made while the app inside is still booting is not refused — it is
# accepted and then reset, which curl's transient-error list does not cover.
# Measured: the retry form returned instantly and every assertion after it read
# an empty reply, which is a harness reporting on nothing.
wait_http() { # wait_http <url> <timeout-seconds>
  local deadline=$((SECONDS + $2))
  until curl -s -m 2 -o /dev/null "$1"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 1
  done
}

# The count of traces this service has landed that are an actual agent turn:
# both samples are health-checked every five seconds, and each probe lands its
# own small api trace. Counting agent spans instead of traces is what keeps the
# checks below about /chat requests rather than about the healthcheck interval.
agent_traces() { # agent_traces <service>
  q "SELECT count() FROM (SELECT trace_id FROM obstack.spans WHERE service='$1'
       GROUP BY trace_id HAVING countIf(layer='agent') > 0)"
}

# Every container this run creates outside the compose profile, by name, so the
# cleanup below removes exactly what it started and nothing else.
probe_containers=(obstack-sdk-failopen-py obstack-sdk-failopen-ts obstack-sdk-otlp-py obstack-sdk-otlp-ts "$OTLP_PROBE")
cleanup() {
  for name in "${probe_containers[@]}"; do docker rm -f "$name" >/dev/null 2>&1; done
  docker volume rm "$OTLP_VOLUME" >/dev/null 2>&1
  return 0
}

step "clean volumes (this run starts from nothing)"
"${compose[@]}" down -v >/dev/null 2>&1
printf '   compose volumes removed\n'

step "refusing to run into anything this run does not own"
# `down -v` removes this profile's containers and the project's volumes. A
# container of the same project still standing afterwards is one somebody else
# brought up under another profile — `--profile demo` is the usual one — and it
# keeps writing into the ClickHouse this run just destroyed and is about to
# recreate. The listing enables every profile on purpose: the narrow `--profile
# sdk` view cannot see the containers that are the problem, which is exactly how
# this script's first run printed a foreign demo container inside its own "the
# stack booted" line and reported on a container it had never started.
foreign="$(docker compose -f "$compose_dir/docker-compose.yml" --profile '*' ps -a --format '{{.Name}}' 2>/dev/null)"
if [ -n "$foreign" ]; then
  refuse "the compose project still has container(s) this run did not start — $(printf '%s' "$foreign" | tr '\n' ' ')— stop them first: docker compose -f deploy/compose/docker-compose.yml --profile '*' down -v"
fi

# Nothing of this project listens now, so anything still answering on one of
# these ports belongs to somebody else, and every assertion below reads HTTP and
# cannot tell one server from another.
for port in "$PY_PORT" "$TS_PORT" "$PY_FAILOPEN_PORT" "$TS_FAILOPEN_PORT" "$PY_OTLP_PORT" "$TS_OTLP_PORT"; do
  if curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/healthz"; then
    refuse "something already answers on 127.0.0.1:$port and this project just stopped everything it owns — stop it first"
  fi
done
for name in "${probe_containers[@]}"; do
  if docker inspect "$name" >/dev/null 2>&1; then
    refuse "a container named $name already exists — a previous run was killed before its cleanup; remove it (docker rm -f $name) and start again"
  fi
done
printf '   no foreign project container, 6 ports free, %s probe container names free\n' "${#probe_containers[@]}"

# Armed only now, past the refusals: the cleanup removes probe containers by
# name, and arming it earlier made a refusal delete the very leftover it had
# just told the reader to go and look at — a harness taking a resource it had
# declared was not its to touch.
trap cleanup EXIT

step "building and booting clickhouse + ingest + both samples"
if ! "${compose[@]}" up -d --build --wait --wait-timeout "$HEALTH_TIMEOUT_S" > "$OUT/up.log" 2>&1; then
  "${compose[@]}" ps
  refuse "the stack did not come up healthy within ${HEALTH_TIMEOUT_S}s — see $OUT/up.log"
fi
printf '   %s\n' "$("${compose[@]}" ps --format '{{.Name}} {{.Health}}' | tr '\n' ' ')"

# One request per sample, copied from each sample's README verbatim (S2.1 L3) —
# same URL, same header, same body. Neither response carries a trace id: reading
# one would take an OpenTelemetry import, and having none is the samples' whole
# claim, which is why the trace is selected from ClickHouse below instead.
step "one documented request per sample"
py_answer="$(curl -s -X POST "http://127.0.0.1:$PY_PORT/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Why did checkout p99 latency jump this afternoon?"}')" \
  || refuse "POST http://127.0.0.1:$PY_PORT/chat failed"
ts_answer="$(curl -s -X POST "http://127.0.0.1:$TS_PORT/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Why did checkout p99 latency jump this afternoon?"}')" \
  || refuse "POST http://127.0.0.1:$TS_PORT/chat failed"
printf '   py: %s\n   ts: %s\n' "$(printf '%s' "$py_answer" | cut -c1-96)" "$(printf '%s' "$ts_answer" | cut -c1-96)"

# The evidence trace, selected by SHAPE and asserted unique. Recency alone would
# be wrong: both samples call their own fake model endpoint over HTTP, the ts
# sample's calls come back through its own server as ordinary requests (T4), and
# compose health-checks both containers every five seconds — each of those lands
# a truthful little api trace of its own. The agent span is the exact
# discriminator: only a /chat request has one. Requiring EXACTLY one match turns
# the selection into an assertion rather than a guess — after a clean boot and
# one request per sample there is precisely one such trace, or this harness is
# measuring something it did not cause.
select_trace() { # select_trace <service>
  local service="$1" deadline=$((SECONDS + ARRIVAL_TIMEOUT_S)) ids count
  while :; do
    ids="$(q "SELECT trace_id FROM obstack.spans WHERE service='$service'
      GROUP BY trace_id HAVING countIf(layer='agent') > 0 AND count() >= 4")"
    count="$(printf '%s' "$ids" | grep -c . )"
    [ "$count" = 1 ] && { printf '%s' "$ids" | tr -d '\n'; return 0; }
    if [ "$count" -gt 1 ]; then
      refuse "$service has $count agent traces, so no single one is 'the' evidence trace: $(printf '%s' "$ids" | tr '\n' ' ')"
    fi
    [ "$SECONDS" -lt "$deadline" ] || refuse "no >= 4-span agent trace for service '$service' within ${ARRIVAL_TIMEOUT_S}s of the request"
    sleep 2
  done
}

step "selecting each sample's evidence trace in ClickHouse"
py_trace="$(select_trace sdk-sample-py)" || exit 1
ts_trace="$(select_trace sdk-sample-ts)" || exit 1
printf '   sdk-sample-py %s\n   sdk-sample-ts %s\n' "$py_trace" "$ts_trace"

# Everything the exit clause claims about one sample's trace, in SQL. Each
# number is read out of ClickHouse and compared here, so a failure names the
# fact that broke rather than "the query returned false".
assert_trace() { # assert_trace <label> <trace_id> <prompt-token> <completion-token>
  local label="$1" trace="$2" prompt_token="$3" completion_token="$4"
  local spans missing llm complete wired agents tools content_keys value_leaks control_prompt control_completion

  spans="$(q "SELECT count() FROM obstack.spans WHERE trace_id='$trace'")"
  claim "$label: the trace is >= 4 spans under one trace_id" \
    "$([ "${spans:-0}" -ge 4 ] && echo 0 || echo 1)" "$spans span(s)"

  missing="$(q "SELECT arrayStringConcat(arrayFilter(l -> NOT has(layers, l), ['api','agent','tool','llm']), ', ')
    FROM (SELECT groupUniqArray(layer) AS layers FROM obstack.spans WHERE trace_id='$trace')")"
  claim "$label: all four layers — api, agent, tool, llm" \
    "$([ -z "$missing" ] && echo 0 || echo 1)" "missing $missing"

  # The D8 extraction, read off the promoted columns: system, both models, both
  # token counts, finish reason, both content columns and the cost ingest
  # computed from them (D9 — the SDKs carry no pricing logic, so a non-zero cost
  # here is ingest having understood the attributes).
  llm="$(q "SELECT countIf(layer='llm') FROM obstack.spans WHERE trace_id='$trace'")"
  complete="$(q "SELECT countIf(layer='llm' AND gen_ai_system != '' AND gen_ai_request_model != ''
      AND gen_ai_response_model != '' AND input_tokens > 0 AND output_tokens > 0 AND finish_reason != ''
      AND prompt != '' AND completion != '' AND cost_usd > 0)
    FROM obstack.spans WHERE trace_id='$trace'")"
  claim "$label: every llm span carries the full D8 set and a non-zero cost" \
    "$([ "${llm:-0}" -ge 1 ] && [ "$complete" = "$llm" ] && echo 0 || echo 1)" "$complete of $llm llm span(s) complete"

  # The wire shape, not just the outcome: the six non-content D8 names are still
  # in the attributes Map exactly as the SDK sent them, which is what makes this
  # the span-attribute form D8 mandates rather than the event form ingest
  # deliberately does not read (D38 FINAL).
  wired="$(q "SELECT countIf(layer='llm' AND hasAll(mapKeys(attributes),
      ['gen_ai.system','gen_ai.request.model','gen_ai.response.model',
       'gen_ai.usage.input_tokens','gen_ai.usage.output_tokens','gen_ai.response.finish_reasons']))
    FROM obstack.spans WHERE trace_id='$trace'")"
  claim "$label: the GenAI attributes arrived as span attributes, all six names" \
    "$([ "$wired" = "$llm" ] && echo 0 || echo 1)" "$wired of $llm llm span(s)"

  agents="$(q "SELECT countIf(layer='agent' AND mapContains(attributes,'obstack.agent.step')) FROM obstack.spans WHERE trace_id='$trace'")"
  tools="$(q "SELECT countIf(layer='tool' AND mapContains(attributes,'obstack.tool.name')) FROM obstack.spans WHERE trace_id='$trace'")"
  claim "$label: the agent step and the tool call name themselves (obstack.agent.step / obstack.tool.name)" \
    "$([ "${agents:-0}" -ge 1 ] && [ "${tools:-0}" -ge 1 ] && echo 0 || echo 1)" "$agents agent, $tools tool span(s)"

  # D92, both halves, over every span row of the trace. Half one is the key
  # absence D8-AMENDMENT has always required. Half two is the one T4's review
  # found missing: content byte-present in the Map under a foreign key
  # (`ai.prompt.messages`) satisfies half one and is still the prompt, readable.
  # The two controls are what keep either half from passing vacuously — they
  # assert the tokens really are in this run's data, in the columns where a
  # reader is supposed to find them.
  content_keys="$(q "SELECT countIf(arrayExists(k -> k IN ('gen_ai.prompt','gen_ai.completion'), mapKeys(attributes)))
    FROM obstack.spans WHERE trace_id='$trace'")"
  value_leaks="$(q "SELECT countIf(arrayExists(v -> position(v, '$prompt_token') > 0 OR position(v, '$completion_token') > 0, mapValues(attributes)))
    FROM obstack.spans WHERE trace_id='$trace'")"
  control_prompt="$(q "SELECT countIf(position(prompt, '$prompt_token') > 0) FROM obstack.spans WHERE trace_id='$trace'")"
  control_completion="$(q "SELECT countIf(position(completion, '$completion_token') > 0) FROM obstack.spans WHERE trace_id='$trace'")"
  claim "$label: prompt and completion are in the dedicated columns (positive control for the two below)" \
    "$([ "${control_prompt:-0}" -ge 1 ] && [ "${control_completion:-0}" -ge 1 ] && echo 0 || echo 1)" \
    "'$prompt_token' in $control_prompt prompt(s), '$completion_token' in $control_completion completion(s)"
  claim "$label: no attributes Map key is gen_ai.prompt or gen_ai.completion (D92 half 1)" \
    "$([ "$content_keys" = 0 ] && echo 0 || echo 1)" "$content_keys span(s) carry one"
  claim "$label: no attributes Map VALUE contains the prompt or completion content, under any key (D92 half 2)" \
    "$([ "$value_leaks" = 0 ] && echo 0 || echo 1)" "$value_leaks span(s) leak content into the Map"
}

step "the four-layer trace, the D8 attributes, and D92's two-part Map assertion"
assert_trace sdk-sample-py "$py_trace" "$PY_PROMPT_TOKEN" "$PY_COMPLETION_TOKEN"
assert_trace sdk-sample-ts "$ts_trace" "$TS_PROMPT_TOKEN" "$TS_COMPLETION_TOKEN"

step "rendering both traces through the shipped query layer (D17 facade)"
if ( cd "$repo_root" && npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
       "$compose_dir/sdk-checks.ts" "$py_trace" "$ts_trace" > "$OUT/sdk-checks.log" 2>&1 ); then
  grep '^sdk-checks:' "$OUT/sdk-checks.log"
  ok "sdk-checks.ts PASS (four layers, llm detail, cost, correlated logs for py — D84)"
else
  grep '^sdk-checks:' "$OUT/sdk-checks.log"
  no "sdk-checks.ts" "see $OUT/sdk-checks.log"
fi

# "The SDKs are thin over the standard OTel SDKs (standard OTLP on the wire,
# verifiable by pointing them at any OTLP endpoint)" — the exit clause, taken
# literally (D80). The endpoint is the stock upstream collector: no obstack
# config, no obstack image, a file exporter, and the assertion is made on what
# that foreign process wrote down.
otlp_leg() { # otlp_leg <label> <compose-service> <host-port> <container-port>
  local label="$1" service="$2" host_port="$3" container_port="$4"
  local name="obstack-sdk-otlp-${label##*-}" dump="$OUT/$label-otlp.json"

  cat > "$OUT/otlp-collector.yaml" <<'YAML'
# A stock collector that has never heard of obstack: OTLP in, file out.
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file:
    path: /out/otlp-spans.json
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file]
    logs:
      receivers: [otlp]
      exporters: [file]
YAML
  # Root, and the output on a named volume rather than a bind mount: the
  # upstream image is a single static binary with no shell and no writable /tmp,
  # and a bind-mounted file written by root inside the container is not
  # necessarily readable by the user running this script. `docker cp` reads it
  # out afterwards with this user's ownership, on every host.
  docker run -d --name "$OTLP_PROBE" --network obstack_default --user 0:0 \
    -v "$OUT/otlp-collector.yaml:/etc/otelcol/config.yaml:ro" -v "$OTLP_VOLUME:/out" \
    "$OTLP_IMAGE" --config /etc/otelcol/config.yaml > "$OUT/$label-collector-run.log" 2>&1 \
    || refuse "the stock collector for $label would not start, so there is no endpoint to point the sample at: $(tail -3 "$OUT/$label-collector-run.log")"
  local ready_deadline=$((SECONDS + 30))
  until docker logs "$OTLP_PROBE" 2>&1 | grep -q 'Everything is ready'; do
    if [ "$SECONDS" -ge "$ready_deadline" ]; then
      docker logs "$OTLP_PROBE" 2>&1 | tail -5
      no "$label: stock collector starts" "$OTLP_IMAGE never reported ready"
      docker rm -f "$OTLP_PROBE" >/dev/null 2>&1; docker volume rm "$OTLP_VOLUME" >/dev/null 2>&1
      return
    fi
    sleep 1
  done

  # The same image, the same two lines of setup, one variable different: the
  # standard OTLP endpoint every OTel SDK reads. A `compose run` that fails is a
  # refusal, not a failed claim — it says this run could not put the sample in
  # front of the collector at all, which is nothing about the SDK. Discarding
  # that output is how the first run of this script measured a container it had
  # never managed to create and reported the absence as an SDK defect.
  "${compose[@]}" run --rm -d --name "$name" -p "127.0.0.1:$host_port:$container_port" \
    -e "OTEL_EXPORTER_OTLP_ENDPOINT=http://$OTLP_PROBE:4318" "$service" > "$OUT/$label-otlp-run.log" 2>&1 \
    || refuse "could not start a one-off $service against the stock collector: $(tail -3 "$OUT/$label-otlp-run.log")"
  if ! wait_http "http://127.0.0.1:$host_port/healthz" 60; then
    no "$label: the OTLP-endpoint instance answers" "nothing on 127.0.0.1:$host_port after 60s — $(docker logs "$name" 2>&1 | tail -3)"
    docker rm -f "$name" "$OTLP_PROBE" >/dev/null 2>&1; docker volume rm "$OTLP_VOLUME" >/dev/null 2>&1
    return
  fi
  curl -s -X POST "http://127.0.0.1:$host_port/chat" -H 'Content-Type: application/json' \
    -d '{"message":"Why did checkout p99 latency jump this afternoon?"}' > "$OUT/$label-otlp-answer.json"
  # Stopping the container is what flushes: both SDKs export on shutdown, and
  # waiting out a batch interval would be a guess where this is a fact.
  docker stop "$name" >/dev/null 2>&1
  # The collector needs the same treatment for the same reason. Its file
  # exporter writes through a buffered writer flushed on a ticker, so reading
  # the file out from under a running collector returns whatever block boundary
  # the writer last crossed: measured, one read in three came back a 4096-byte
  # prefix carrying `"resourceSpans"` and none of the span names — the two
  # assertions below going red for the harness's own timing while the SDK had
  # done everything right (CI run 32050998523 is exactly that). Shutting the
  # collector down flushes and closes the file, so what is copied is a finished
  # file rather than a snapshot. It is removed a few lines below anyway.
  docker stop "$OTLP_PROBE" >/dev/null 2>&1
  docker cp "$OTLP_PROBE:/out/otlp-spans.json" "$dump" >/dev/null 2>&1

  # `resourceSpans` rather than a non-empty file: the collector's logs pipeline
  # writes into the same file, and the py sample emits logs, so a dump holding
  # only log records would otherwise read as "the trace arrived".
  local received=1 names_found=0 attrs_found=0
  grep -q '"resourceSpans"' "$dump" 2>/dev/null || received=0
  if [ "$received" = 1 ]; then
    names_found=1
    for span_name in agent.answer_question tool.knowledge_lookup 'chat gpt-4o-mini'; do
      grep -q "$span_name" "$dump" || names_found=0
    done
    attrs_found=1
    for attr in gen_ai.system gen_ai.request.model gen_ai.usage.input_tokens gen_ai.prompt gen_ai.completion; do
      grep -q "$attr" "$dump" || attrs_found=0
    done
  fi
  claim "$label: a stock $OTLP_IMAGE received the trace over standard OTLP and wrote it out" \
    "$([ "$received" = 1 ] && echo 0 || echo 1)" "no span output at $dump"
  claim "$label: that output carries the sample's span names (agent./tool./chat)" \
    "$([ "$names_found" = 1 ] && echo 0 || echo 1)" "see $dump"
  claim "$label: and the gen_ai.* attributes, prompt and completion included" \
    "$([ "$attrs_found" = 1 ] && echo 0 || echo 1)" "see $dump"

  docker rm -f "$OTLP_PROBE" >/dev/null 2>&1
  docker volume rm "$OTLP_VOLUME" >/dev/null 2>&1
}

step "standard OTLP on the wire: each sample against a stock upstream collector"
otlp_leg sdk-sample-py sdk-sample-py "$PY_OTLP_PORT" 8010
otlp_leg sdk-sample-ts sdk-sample-ts "$TS_OTLP_PORT" 8100

# PRD §9 / D83, as app-observable behaviour: a broken endpoint never breaks the
# app. The dead port is the assembled whole — init(), the instrumentations, the
# batch processors and the exporter — not a unit test of the catch.
failopen_leg() { # failopen_leg <label> <compose-service> <host-port> <container-port> <before-count>
  local label="$1" service="$2" host_port="$3" container_port="$4" before="$5"
  local name="obstack-sdk-failopen-${label##*-}" code after

  # Same refusal-vs-claim split as the OTLP leg: docker being unable to create
  # the container says nothing about fail-open, and swallowing that would let
  # the leg report an SDK failure that never happened.
  "${compose[@]}" run --rm -d --name "$name" -p "127.0.0.1:$host_port:$container_port" \
    -e "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9" "$service" > "$OUT/$label-failopen-run.log" 2>&1 \
    || refuse "could not start a one-off $service on the dead-endpoint leg: $(tail -3 "$OUT/$label-failopen-run.log")"
  if ! wait_http "http://127.0.0.1:$host_port/healthz" 60; then
    # Not a soft failure: an app that will not start against a dead endpoint has
    # already broken the fail-open claim, before any request is made.
    no "$label: the app starts at all with the endpoint on a dead port" "nothing on 127.0.0.1:$host_port after 60s — $(docker logs "$name" 2>&1 | tail -3)"
    docker rm -f "$name" >/dev/null 2>&1
    return
  fi
  code="$(curl -s -o "$OUT/$label-failopen-answer.json" -w '%{http_code}' \
    -X POST "http://127.0.0.1:$host_port/chat" -H 'Content-Type: application/json' \
    -d '{"message":"Why did checkout p99 latency jump this afternoon?"}')"
  claim "$label: with the endpoint on a dead port, /chat still answers 200 with its real answer" \
    "$([ "$code" = 200 ] && [ -s "$OUT/$label-failopen-answer.json" ] && echo 0 || echo 1)" "HTTP $code"

  # The control that keeps the leg from being a description of an ordinary run:
  # the endpoint really was dead, so this agent turn is nowhere in ClickHouse.
  # The container is stopped first — both SDKs flush on shutdown, so anything
  # that could still land has by then.
  docker stop "$name" >/dev/null 2>&1
  sleep 3
  after="$(agent_traces "$label")"
  claim "$label: and none of that run's telemetry reached ClickHouse (the port was really dead)" \
    "$([ "$after" = "$before" ] && echo 0 || echo 1)" "agent traces went from $before to $after"
}

step "fail open: a dead endpoint never breaks the sample app (PRD §9 / D83)"
py_traces_before="$(agent_traces sdk-sample-py)"
ts_traces_before="$(agent_traces sdk-sample-ts)"
failopen_leg sdk-sample-py sdk-sample-py "$PY_FAILOPEN_PORT" 8010 "$py_traces_before"
failopen_leg sdk-sample-ts sdk-sample-ts "$TS_FAILOPEN_PORT" 8100 "$ts_traces_before"

step "the D15 regression floor: demo/agent-app/ is what it was"
floor="$(cd "$repo_root" && git diff --stat -- demo/agent-app/)"
claim "demo/agent-app/ is untouched — the bring-your-own-OTel proof still stands beside the SDK one" \
  "$([ -z "$floor" ] && echo 0 || echo 1)" "$floor"

step "result"
printf '   %s passed, %s failed — artifacts in %s\n' "$pass" "$fail" "$OUT"
[ "$fail" = 0 ] || exit 1
printf '\nsdk-evidence: PASS (%ss)\n' "$SECONDS"
