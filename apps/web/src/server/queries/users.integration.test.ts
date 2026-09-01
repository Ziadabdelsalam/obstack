import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { forWorkspace } from "@/server/clickhouse";
import { SLOW_NS } from "@/lib/users-types";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of D398's frozen contract (users.test.ts is the
// hermetic half): real rows in `obstack.spans`, real GROUP BY/argMaxIf/window
// math — nothing a mocked `ScopedClickHouse` can exercise. Seeding writes RAW
// rows straight into `spans` with the ingest-privileged client, the same
// house pattern as traces.integration.test.ts/metrics.integration.test.ts.
//
// Skips only when no ClickHouse answers; `web.yml`'s D36 skip trap fails the
// job on an unexpected skip, so this file executes on every PR.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

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

/**
 * Two workspaces of this run's own, never the compose dev default `ws_demo`
 * (traces.integration.test.ts precedent) — the seeding user has no mutation
 * grant, so nothing here can be cleaned up afterwards. `WORKSPACE_B` is the
 * second tenant the "second workspace sees none" probe needs.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;

const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);
const NS_PER_HOUR = NS_PER_SECOND * BigInt(3600);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` — mirrors traces.integration.test.ts's `chTimestamp`. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

/** A `spans` row with the house defaults for the columns this probe does not care about. */
function spanRow(overrides: {
  workspace_id?: string;
  trace_id: string;
  span_id: string;
  start_time: string;
  duration_ns: string;
  parent_span_id?: string;
  name?: string;
  status_code?: string;
  attributes?: Record<string, string>;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    parent_span_id: "",
    name: "GET /home",
    kind: "server",
    service: "users-it",
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
    k8s_namespace: "",
    k8s_pod: "",
    k8s_container: "app",
    k8s_node: "",
    resource_attributes: {},
    ...overrides,
    attributes: overrides.attributes ?? {},
  };
}

test("listImpactedUsers (D398) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { listImpactedUsers } = await import("./users");
  const ch = forWorkspace(WORKSPACE_ID);

  const suffix = randomBytes(6).toString("hex");
  const userA = `user-a-${suffix}`; // identity via attributes['enduser.id']
  const userB = `user-b-${suffix}`; // identity via attributes['user.id']
  const userC = `user-c-${suffix}`; // ONLY a 25h-old span — must be excluded entirely

  const now0 = BigInt(Date.now()) * NS_PER_MS;
  const FAST_NS = "100000000"; // 100ms — well under SLOW_NS
  const SLOW_DURATION_NS = (SLOW_NS + 1_000_000_000).toString(); // comfortably >= SLOW_NS (2s)

  // ---- userA (enduser.id): 1 ok-fast + 2 error-slow root spans -----------
  // failures/requests = 2/3 ≈ 66.7% -> at-risk. The two error spans are
  // ordered so `last_failure_older` is NOT the most recent — this is what
  // proves argMaxIf picks the LATEST failure, not just any failure.
  const okTraceA = `it_a_ok_${suffix}`;
  const oldFailTraceA = `it_a_oldfail_${suffix}`;
  const newFailTraceA = `it_a_newfail_${suffix}`;
  /** Pinned so the `at` string the surface renders can be asserted EXACTLY (it is the SQL's `formatDateTime` output, nothing else checks that format string). */
  const newFailStartA = chTimestamp(now0 - BigInt(30) * NS_PER_SECOND);

  // ---- userB (user.id): 10 ok-fast + 1 error-slow root spans -------------
  // failures/requests = 1/11 ≈ 9.09% -> degraded (>= 2%, < 10%).
  const newFailTraceB = `it_b_newfail_${suffix}`;

  const rowsA = [
    spanRow({
      trace_id: okTraceA,
      span_id: "s1",
      name: "GET /home",
      status_code: "ok",
      start_time: chTimestamp(now0 - BigInt(90) * NS_PER_SECOND),
      duration_ns: FAST_NS,
      attributes: { "enduser.id": userA },
    }),
    spanRow({
      trace_id: oldFailTraceA,
      span_id: "s1",
      name: "POST /old-failure",
      status_code: "error",
      start_time: chTimestamp(now0 - BigInt(60) * NS_PER_SECOND),
      duration_ns: SLOW_DURATION_NS,
      attributes: { "enduser.id": userA },
    }),
    spanRow({
      trace_id: newFailTraceA,
      span_id: "s1",
      name: "POST /checkout",
      status_code: "error",
      start_time: newFailStartA,
      duration_ns: SLOW_DURATION_NS,
      attributes: { "enduser.id": userA },
    }),
    // A CHILD span (non-root) carrying the SAME identity, more recent and
    // worse than every root span above — if this were wrongly counted it
    // would change userA's requests/failures/slow AND become the new
    // lastFailure. It must change nothing.
    spanRow({
      trace_id: newFailTraceA,
      span_id: "s2",
      parent_span_id: "s1",
      name: "child span — must not be counted",
      status_code: "error",
      start_time: chTimestamp(now0 - BigInt(1) * NS_PER_SECOND),
      duration_ns: SLOW_DURATION_NS,
      attributes: { "enduser.id": userA },
    }),
  ];

  const rowsB = Array.from({ length: 10 }, (_, i) =>
    spanRow({
      trace_id: `it_b_ok_${i}_${suffix}`,
      span_id: "s1",
      name: "GET /home",
      status_code: "ok",
      start_time: chTimestamp(now0 - BigInt(120 + i) * NS_PER_SECOND),
      duration_ns: FAST_NS,
      attributes: { "user.id": userB },
    }),
  ).concat([
    spanRow({
      trace_id: newFailTraceB,
      span_id: "s1",
      name: "POST /submit",
      status_code: "error",
      start_time: chTimestamp(now0 - BigInt(45) * NS_PER_SECOND),
      duration_ns: SLOW_DURATION_NS,
      attributes: { "user.id": userB },
    }),
  ]);

  const rowC = spanRow({
    trace_id: `it_c_old_${suffix}`,
    span_id: "s1",
    name: "GET /stale",
    status_code: "error",
    // 25h old — outside the 24h window; must be excluded entirely (userC
    // must not appear in the result at all, since this is its only span).
    start_time: chTimestamp(now0 - BigInt(25) * NS_PER_HOUR),
    duration_ns: SLOW_DURATION_NS,
    attributes: { "enduser.id": userC },
  });

  await seed.insert({ table: "spans", format: "JSONEachRow", values: [...rowsA, ...rowsB, rowC] });

  const { users, totalUsers } = await listImpactedUsers(ch);

  await t.test("userA (enduser.id): exact counts, at-risk, and the LATEST error is lastFailure — the child span and old failure change nothing", () => {
    const a = users.find((u) => u.userId === userA);
    assert.ok(a, "userA did not appear in the result");
    assert.equal(a!.requests, 3, "only the 3 ROOT spans count — the child span must be excluded");
    assert.equal(a!.failures, 2);
    assert.equal(a!.slow, 2);
    assert.equal(a!.risk, "at-risk");
    assert.deepEqual(a!.lastFailure, {
      traceId: newFailTraceA,
      rootName: "POST /checkout",
      // The seeded start_time, as the SQL's formatDateTime renders it.
      at: `${newFailStartA.slice(0, 19).replace(" ", "T")}Z`,
    });
    // Proves argMaxIf picked the MOST RECENT failure, not the older one.
    assert.notEqual(a!.lastFailure!.traceId, oldFailTraceA);
  });

  await t.test("userB (user.id): exact counts and degraded (failures below the at-risk floor, above the degraded floor)", () => {
    const b = users.find((u) => u.userId === userB);
    assert.ok(b, "userB did not appear in the result");
    assert.equal(b!.requests, 11);
    assert.equal(b!.failures, 1);
    assert.equal(b!.slow, 1);
    assert.equal(b!.risk, "degraded");
    assert.equal(b!.lastFailure?.traceId, newFailTraceB);
    assert.equal(b!.lastFailure?.rootName, "POST /submit");
  });

  await t.test("userC: a 25h-old row is excluded — the identity never appears at all", () => {
    assert.equal(
      users.find((u) => u.userId === userC),
      undefined,
      "a span outside the 24h window must not produce a user, even when it is that identity's only span",
    );
  });

  await t.test("totalUsers is the DISTINCT-identity count (2), not the row count of the 14 in-window root spans", () => {
    // This workspace is this run's own, so the number is exact: `count() OVER ()`
    // must count GROUPS (userA, userB — userC is outside the window), which is
    // what makes the D402 banner's "of N users" true.
    assert.equal(totalUsers, 2);
  });
});

test("listImpactedUsers: a second workspace with nothing seeded sees none of the first workspace's users", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { listImpactedUsers } = await import("./users");

  const suffix = randomBytes(6).toString("hex");
  const soleUser = `user-solo-${suffix}`;

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      spanRow({
        trace_id: `it_solo_${suffix}`,
        span_id: "s1",
        name: "GET /home",
        status_code: "ok",
        start_time: chTimestamp(BigInt(Date.now()) * NS_PER_MS),
        duration_ns: "100000000",
        attributes: { "enduser.id": soleUser },
      }),
    ],
  });

  const b = forWorkspace(WORKSPACE_B);
  const { users, totalUsers } = await listImpactedUsers(b);
  assert.deepEqual(users, [], "a workspace with no seeded spans of its own must see no users, including the other tenant's");
  assert.equal(totalUsers, 0);
});
