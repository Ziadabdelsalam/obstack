import assert from "node:assert/strict";
import test from "node:test";
import { RECENT_HOURS, WINDOW_HOURS } from "@/lib/issues-types";
import { forWorkspace } from "@/server/clickhouse";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { ISSUE_CAP, listIssues } from "./issues";

// run with: npm test --workspace apps/web -- issues
//
// Hermetic (D96/D113), like metrics.test.ts: nothing here needs a live
// ClickHouse. What the SQL DOES to real rows — the fingerprint's grouping and
// the 24h bound against actual data — is issues.integration.test.ts's half;
// this half is about what leaves the process.

// ---- unscoped-SQL tripwire, proven red for this module's table -------------

test("tripwire: a bare SELECT against obstack.spans is refused before any query runs", async () => {
  const ch = forWorkspace("ws_issues_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT service, name FROM obstack.spans WHERE status_code = 'error'"),
    /refusing unscoped SQL/,
  );
});

// ---- what the query layer sends (D113: no query names a workspace) ---------

type Call = { sql: string; params: Record<string, unknown> };

function recorder(rows: unknown[]): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return rows as Row[];
      },
    },
  };
}

/** A row shaped exactly like the SQL's output, with the columns a probe ignores defaulted. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    fingerprint: "0123456789abcdef",
    service: "checkout",
    layer: "tool",
    span_name: "search_kb",
    normalized: "timeout after <num>ms for order <num>",
    occurrences: 3,
    spark_buckets: [0, 23],
    spark_counts: [1, 2],
    first_seen_epoch_s: 0,
    last_seen_epoch_s: 0,
    example_trace_id: "b7e2d94a1c8f5e30",
    total_issues: 1,
    ...overrides,
  };
}

const nowS = () => Math.floor(Date.now() / 1000);

test("listIssues: one scoped read over error spans in the last 24h, with no interpolated input", async () => {
  const { ch, calls } = recorder([row()]);
  const before = nowS();
  await listIssues(ch);
  const after = nowS();

  assert.equal(calls.length, 1, "listIssues must answer in a single statement");
  const { sql, params } = calls[0];

  assert.ok(sql.includes("{workspace_id:"), "the statement carries no workspace placeholder (D113)");
  assert.ok(!("workspace_id" in params), "only the scope may bind a workspace_id (D113)");
  assert.ok(sql.includes("obstack.spans"), "listIssues did not read obstack.spans");
  assert.ok(!sql.includes("obstack.logs"), "logs are OUT of issues v1 (D399)");
  assert.ok(!sql.includes("FINAL"), "the never-FINAL house rule");
  assert.ok(sql.includes("status_code = 'error'"), "issues are error spans only (D399)");

  // D11: every value the statement depends on arrives through query_params.
  // `listIssues` takes no caller input at all, so the only way a value could
  // reach the SQL text is the module baking one in — which is what these two
  // check, by looking for the numbers it bound.
  assert.ok(sql.includes("{since_s:UInt32}"), "the window bound must be a placeholder");
  assert.ok(sql.includes("{cap:UInt32}"), "the cap must be a placeholder");
  assert.equal(
    /\b\d{9,}\b/.test(sql),
    false,
    "the SQL text carries an epoch-looking literal — a bound value was interpolated",
  );

  // D394: one fixed window, 24h, measured from now — not a parameter of the call.
  const sinceS = params.since_s as number;
  assert.ok(
    sinceS >= before - WINDOW_HOURS * 3600 && sinceS <= after - WINDOW_HOURS * 3600,
    `since_s (${sinceS}) is not ${WINDOW_HOURS}h before now`,
  );
  // D402: the cap the banner states is the cap the statement applies.
  assert.equal(params.cap, ISSUE_CAP);
  assert.equal(ISSUE_CAP, 50);
});

test("listIssues: the sparkline is 24 hourly buckets, oldest first, gap-filled with measured zeros", async () => {
  const { ch } = recorder([row({ occurrences: 3, spark_buckets: [0, 23], spark_counts: [1, 2] })]);
  const { issues } = await listIssues(ch);

  assert.equal(issues[0].spark.length, WINDOW_HOURS);
  assert.equal(issues[0].spark[0], 1, "the oldest bucket is first");
  assert.equal(issues[0].spark[23], 2, "the newest bucket is last");
  assert.equal(
    issues[0].spark.reduce((a, b) => a + b, 0),
    issues[0].count,
    "the sparkline must sum to the issue's count — a 0 here is a measured zero, never a dropped bucket",
  );
  assert.deepEqual(issues[0].spark.slice(1, 23), new Array(22).fill(0));
});

test("listIssues: status is recency against the 6h anchor and nothing else (D361/D399)", async () => {
  const now = nowS();
  const recent = now - RECENT_HOURS * 3600;
  const { ch } = recorder([
    // every occurrence inside the last 6h
    row({ fingerprint: "aaa", first_seen_epoch_s: recent + 600, last_seen_epoch_s: now - 60, total_issues: 3 }),
    // nothing inside the last 6h
    row({ fingerprint: "bbb", first_seen_epoch_s: now - 9 * 3600, last_seen_epoch_s: recent - 600, total_issues: 3 }),
    // straddles the anchor
    row({ fingerprint: "ccc", first_seen_epoch_s: now - 9 * 3600, last_seen_epoch_s: now - 60, total_issues: 3 }),
  ]);

  const { issues } = await listIssues(ch);
  assert.deepEqual(
    issues.map((i) => i.status),
    ["new", "resolved", "ongoing"],
  );
});

test("listIssues: an issue at the 6h boundary is ongoing, not resolved", async () => {
  const now = nowS();
  const { ch } = recorder([
    // last occurrence exactly at the anchor: inside the last 6h, so it is still happening
    row({ first_seen_epoch_s: now - 9 * 3600, last_seen_epoch_s: now - RECENT_HOURS * 3600 }),
  ]);
  const { issues } = await listIssues(ch);
  assert.equal(issues[0].status, "ongoing");
});

test("listIssues: the normalized message titles the issue; an empty message falls back to the span name", async () => {
  const { ch } = recorder([
    row({ normalized: "timeout after <num>ms for order <num>", span_name: "search_kb" }),
    row({ normalized: "", span_name: "kb.lookup" }),
  ]);
  const { issues } = await listIssues(ch);
  assert.equal(issues[0].title, "timeout after <num>ms for order <num>");
  assert.equal(issues[1].title, "kb.lookup");
});

test("listIssues: instants are ISO UTC minutes and the pre-cap total crosses for the banner", async () => {
  const { ch } = recorder([
    row({ first_seen_epoch_s: 1_788_255_346, last_seen_epoch_s: 1_788_258_946, total_issues: 137 }),
  ]);
  const { issues, total } = await listIssues(ch);
  assert.equal(issues[0].firstSeenAt, "2026-09-01T09:35Z");
  assert.equal(issues[0].lastSeenAt, "2026-09-01T10:35Z");
  assert.equal(total, 137, "total is the distinct-issue count BEFORE the cap (D402)");
});

test("listIssues: an empty workspace is an empty result, never a fabricated row", async () => {
  const { ch } = recorder([]);
  assert.deepEqual(await listIssues(ch), { issues: [], total: 0 });
});
