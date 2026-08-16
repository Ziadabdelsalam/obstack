import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// This is the seeded-ClickHouse half of T3's nearby-logs done-check (D37.4,
// kickoff Decisions 3-5). The WHERE clause NEARBY_LOGS_SQL builds — the pod/
// namespace subquery, the window bound, the `trace_id = ''` restriction — is
// real SQL that a pure adapter unit test (adapters.test.ts) cannot exercise;
// only a real server can prove it. Follows the same skip-not-fail convention
// as services/ingest's integration_test.go: no ClickHouse reachable reports
// SKIP, not a broken `web` check, so a plain `npm test` (CI's `web` job does
// not start ClickHouse) stays green.
//
// Env vars mirror deploy/compose/README.md's live-mode block exactly
// (CLICKHOUSE_URL / CLICKHOUSE_USER / CLICKHOUSE_PASSWORD) so this reads
// through `queryTrace` with the same client the app uses — nothing here talks
// to ClickHouse through a side channel except the ingest-privileged seeding
// client, which stands in for the writer this sprint does not touch.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

// `queryTrace` (imported below) reads these lazily on its first query, inside
// `@/server/clickhouse.ts`'s `getClient()` — set before any test runs so that
// first call resolves to this ClickHouse instead of throwing.
process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = WEB_USER;
process.env.CLICKHOUSE_PASSWORD = WEB_PASSWORD;

const seed = createClient({
  url: CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: INGEST_PASSWORD,
  database: "obstack",
});

async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seed.ping()).success;
  } catch {
    return false;
  }
}

/** `workspaceId` in `@/server/clickhouse.ts` defaults to this when unset — matches the compose dev default, so no env override is needed. */
const WORKSPACE_ID = "ws_demo";

// BigInt literal syntax (`123n`) needs an ES2020 target; tsconfig.json pins
// ES2017, so every constant here goes through the `BigInt(...)` call form
// instead — same runtime value, no down-level syntax error.
const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'`; a JS `Date` tops out at millisecond precision and would silently truncate the offsets under test. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

function spanRow(overrides: {
  trace_id: string;
  span_id: string;
  start_time: string;
  duration_ns: string;
  k8s_namespace: string;
  k8s_pod: string;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    parent_span_id: "",
    name: "POST /chat",
    kind: "server",
    service: "demo-agent-it",
    status_code: "ok",
    status_message: "",
    layer: "api",
    gen_ai_system: "",
    gen_ai_request_model: "",
    gen_ai_response_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    finish_reason: "",
    prompt: "",
    completion: "",
    k8s_container: "app",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

function logRow(overrides: {
  trace_id: string;
  timestamp: string;
  body: string;
  k8s_namespace: string;
  k8s_pod: string;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    span_id: "",
    severity_number: 9,
    severity_text: "INFO",
    service: "demo-agent-it",
    k8s_container: "sidecar",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

test("nearby-logs join (D37.4) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(
      `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`,
    );
    return;
  }

  const { queryTrace } = await import("./traces");

  const suffix = randomBytes(6).toString("hex");
  const traceId = `it_nearby_${suffix}`;
  const foreignTraceId = `it_foreign_${suffix}`;
  const namespace = `it-ns-${suffix}`;
  const pod = `it-pod-${suffix}`;
  const otherPod = `it-otherpod-${suffix}`;

  const windowNs = BigInt(10) * NS_PER_SECOND; // NEARBY_LOG_WINDOW_NS — pinned literally so this test fails if the constant ever drifts silently
  const t0 = BigInt(Date.now()) * NS_PER_MS; // trace start, epoch ns
  const durationNs = BigInt(5) * NS_PER_SECOND; // 5s span
  const t1 = t0 + durationNs; // trace end (max_end)

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      spanRow({
        trace_id: traceId,
        span_id: "s1",
        start_time: chTimestamp(t0),
        duration_ns: durationNs.toString(),
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
    ],
  });

  const nearbyBefore = "PROBE:nearby-before-start";
  const nearbyAfter = "PROBE:nearby-after-end";
  const differentPodBody = "PROBE:different-pod";
  const outsideWindowBody = "PROBE:outside-window";
  const foreignTraceBody = "PROBE:foreign-trace-id";

  await seed.insert({
    table: "logs",
    format: "JSONEachRow",
    values: [
      // inside the window, before trace start — must appear, negative atMs
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t0 - windowNs / BigInt(2)),
        body: nearbyBefore,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // inside the window, after trace end — must appear, positive atMs
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t1 + windowNs / BigInt(2)),
        body: nearbyAfter,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // probe 1: same window, different pod — must NOT appear
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t0 + NS_PER_SECOND),
        body: differentPodBody,
        k8s_namespace: namespace,
        k8s_pod: otherPod,
      }),
      // probe 2: same pod, outside the window on both sides — must NOT appear
      logRow({
        trace_id: "",
        timestamp: chTimestamp(t0 - windowNs - BigInt(5) * NS_PER_SECOND),
        body: outsideWindowBody,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
      // probe 3: same pod, inside the window, but carries a (foreign) trace_id — must NOT appear in this trace's nearby set
      logRow({
        trace_id: foreignTraceId,
        timestamp: chTimestamp(t0 + NS_PER_SECOND),
        body: foreignTraceBody,
        k8s_namespace: namespace,
        k8s_pod: pod,
      }),
    ],
  });

  const trace = await queryTrace(traceId);
  assert.ok(trace, "queryTrace found no row for the seeded trace");

  const bodies = trace.logs.map((l) => l.body);
  const byBody = new Map(trace.logs.map((l) => [l.body, l]));

  await t.test("logs inside the window on the trace's pod land as nearby, signed atMs preserved", () => {
    const before = byBody.get(nearbyBefore);
    const after = byBody.get(nearbyAfter);
    assert.ok(before, "log before trace start, inside the window, did not resolve as nearby");
    assert.ok(after, "log after trace end, inside the window, did not resolve as nearby");
    assert.equal(before!.traceId, undefined);
    assert.equal(after!.traceId, undefined);
    assert.ok(before!.atMs < 0, `expected a negative atMs for a before-start nearby log, got ${before!.atMs}`);
    assert.ok(after!.atMs > 0, `expected a positive atMs for an after-end nearby log, got ${after!.atMs}`);
  });

  await t.test("falsification probe: a log from a different pod stays out of the nearby set", () => {
    assert.ok(
      !bodies.includes(differentPodBody),
      "a log from a different pod leaked into this trace's nearby logs",
    );
  });

  await t.test("falsification probe: a log outside the window stays out of the nearby set", () => {
    assert.ok(
      !bodies.includes(outsideWindowBody),
      "a log outside the ±window leaked into this trace's nearby logs",
    );
  });

  await t.test("falsification probe: a log carrying a (foreign) trace_id stays out of the nearby set", () => {
    assert.ok(
      !bodies.includes(foreignTraceBody),
      "a log carrying another trace's trace_id leaked into this trace's nearby logs",
    );
  });
});
