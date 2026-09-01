import assert from "node:assert/strict";
import test from "node:test";
import { forWorkspace } from "@/server/clickhouse";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { WINDOW_HOURS } from "@/lib/users-types";
import { listImpactedUsers, riskFor } from "./users";

// run with: npm test --workspace apps/web -- users
//
// Hermetic (D96/D113), like tenancy.test.ts and metrics.test.ts: nothing here
// needs a live ClickHouse. The seeded-server half of the same contract lives
// in users.integration.test.ts.

// ---- unscoped-SQL tripwire, proven red per table (D398) ---------------------

test("tripwire: a bare SELECT against obstack.spans is refused before any query runs", async () => {
  const ch = forWorkspace("ws_users_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT name FROM obstack.spans WHERE parent_span_id = ''"),
    /refusing unscoped SQL/,
  );
});

// ---- what the query layer sends (D113/D11) -----------------------------------

type Call = { sql: string; params: Record<string, unknown> };

function recorder(responder: () => unknown[]): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return responder() as Row[];
      },
    },
  };
}

test("listImpactedUsers: the statement is scoped, both identity keys are SQL-text literals, and the window is a fixed 24h literal", async () => {
  const { ch, calls } = recorder(() => []);
  await listImpactedUsers(ch);

  assert.equal(calls.length, 1, "listImpactedUsers must issue exactly one statement");
  const sql = calls[0].sql;

  assert.ok(sql.includes("{workspace_id:"), "the statement carries no workspace placeholder — a cross-tenant read");
  assert.ok(!("workspace_id" in calls[0].params), "the caller must not bind its own workspace_id — the scope is the only thing allowed to (D113)");

  // D398: both key strings are literal SQL text, never a parameter or built
  // by interpolation from anything this module was handed (there is no input
  // to interpolate from at all — `listImpactedUsers` takes only `ch`).
  assert.ok(sql.includes("attributes['enduser.id']"), "identity must read the enduser.id key literally");
  assert.ok(sql.includes("attributes['user.id']"), "identity must fall back to the user.id key literally");
  assert.equal(
    Object.keys(calls[0].params).sort().join(","),
    "slow_ns",
    "the only bound parameter is slow_ns — enduser.id/user.id are never parameters (D11)",
  );

  // D394: the window is a fixed literal owned by lib/users-types.ts, not a
  // caller-supplied range argument (listImpactedUsers takes no such argument
  // at all — this only proves the literal names the same constant).
  assert.ok(
    sql.includes(`INTERVAL ${WINDOW_HOURS} HOUR`),
    "the 24h window must be a literal bound, not a parameter",
  );
  assert.ok(sql.includes("parent_span_id = ''"), "population must be ROOT spans only");
});

test("listImpactedUsers: maps a full row, and omits lastFailure when failures is 0", async () => {
  const { ch } = recorder(() => [
    {
      identity: "user_1",
      requests: "100",
      failures: "10",
      slow: "3",
      last_failure_trace_id: "trace-abc",
      last_failure_name: "POST /checkout",
      last_failure_at: "2026-09-01T00:03:04Z",
      total_users: "2",
    },
    {
      identity: "user_2",
      requests: "50",
      failures: "0",
      slow: "0",
      last_failure_trace_id: "",
      last_failure_name: "",
      last_failure_at: "1970-01-01T00:00:00Z",
      total_users: "2",
    },
  ]);

  const { users, totalUsers } = await listImpactedUsers(ch);
  assert.equal(totalUsers, 2);
  assert.deepEqual(users[0], {
    userId: "user_1",
    requests: 100,
    failures: 10, // 10/100 = 10% -> at-risk (the riskFor boundary tests below cover the exact threshold math)
    slow: 3,
    lastFailure: { traceId: "trace-abc", rootName: "POST /checkout", at: "2026-09-01T00:03:04Z" },
    risk: "at-risk",
  });
  assert.deepEqual(users[1].lastFailure, null, "a user with zero failures must not carry a fabricated lastFailure");
});

test("listImpactedUsers: totalUsers is 0 when the workspace has no impacted users", async () => {
  const { ch } = recorder(() => []);
  const { users, totalUsers } = await listImpactedUsers(ch);
  assert.deepEqual(users, []);
  assert.equal(totalUsers, 0);
});

// ---- riskFor: D398's boundaries, exact (10% / 2% / 20%) ---------------------

test("riskFor: at-risk at exactly the 10% failure boundary, healthy just under it", () => {
  assert.equal(riskFor(100, 10, 0), "at-risk", "10/100 = 10% must be at-risk (>= wins)");
  assert.equal(riskFor(100, 9, 0), "degraded", "9/100 = 9% is under at-risk but still >= the 2% degraded floor");
});

test("riskFor: degraded at exactly the 2% failure boundary, healthy just under it", () => {
  assert.equal(riskFor(100, 2, 0), "degraded", "2/100 = 2% must be degraded (>= wins)");
  assert.equal(riskFor(100, 1, 0), "healthy", "1/100 = 1% failures with no slow requests must be healthy");
});

test("riskFor: degraded at exactly the 20% slow boundary (failures alone would be healthy), healthy just under it", () => {
  assert.equal(riskFor(100, 0, 20), "degraded", "20/100 slow = 20% must be degraded (>= wins) even with zero failures");
  assert.equal(riskFor(100, 0, 19), "healthy", "19/100 slow = 19% is under the slow floor with zero failures");
});

test("riskFor: at-risk outranks a simultaneously-true slow-degraded condition", () => {
  assert.equal(riskFor(100, 10, 50), "at-risk", "at-risk is evaluated first regardless of how bad slow also is");
});

test("riskFor: requests === 0 is healthy (defensive; not a real GROUP BY row)", () => {
  assert.equal(riskFor(0, 0, 0), "healthy");
});
