import assert from "node:assert/strict";
import test from "node:test";
import { fakeBilling } from "./fake";
import type { BillingClient, UsageEvent } from "./types";

// run with: npm test --workspace apps/web
//
// The reporter contract (D170), proven against the fake — which deduplicates on
// `externalId` honestly and reports real `duplicates` counts, so "re-sending a
// closed window is free" is a proof about our external ids and not about a Map
// that swallows everything (D168). No Postgres and no Polar: `query` and
// `billing` are injected, and the clock is a parameter.
//
// The module reads `dataMode` at import, which is resolved at ITS module load
// (S2.4 L4) — so the mode is set here, before the dynamic import below, and the
// runner's per-file process isolation keeps it out of every other file.
process.env.OBSTACK_DATA_MODE = "live";
process.env.CLICKHOUSE_URL = "http://clickhouse.invalid:8123";
delete process.env.OBSTACK_BILLING_MODE;
delete process.env.POLAR_ACCESS_TOKEN;

const loadReporter = () => import("./reporter");

const HOUR_MS = 60 * 60 * 1000;

/**
 * A ledger row as `pg` hands it over: `period_start` a `Date`, and the two
 * BIGINT columns as STRINGS — which is the reason the reporter runs them
 * through `Number` before they become metadata, and the reason this fixture
 * does not quietly hand it numbers it would never see in production.
 */
function ledgerRow(workspaceId: string, periodStart: string, spans: number, logs: number) {
  return {
    workspace_id: workspaceId,
    period_start: new Date(periodStart),
    spans: String(spans),
    logs: String(logs),
  };
}

/** A recording `queryRows` over a fixed result set: every statement, and no database. */
function ledger(rows: ReturnType<typeof ledgerRow>[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return rows;
  };
  return { calls, query: query as never };
}

/**
 * The fake rail with a tap on it: the dedup below is the fake's real dedup, and
 * `sent` is what we asked it to ingest — the two things every assertion here
 * needs, without a second implementation of either.
 */
function tapped() {
  const sent: UsageEvent[][] = [];
  const billing: BillingClient = {
    ...fakeBilling,
    async ingestUsage(events: UsageEvent[]) {
      sent.push(events);
      return fakeBilling.ingestUsage(events);
    },
  };
  return { sent, billing };
}

test("a closed window sends once; re-sending it is free (D170 idempotency)", async () => {
  const { runReporterOnce } = await loadReporter();
  const { sent, billing } = tapped();
  // The fake's dedup set is process-wide, exactly as Polar's is account-wide,
  // so every test names a workspace of its own.
  const ws = "ws_idem";
  const now = new Date("2026-08-19T12:30:00.000Z");
  const rows = [
    ledgerRow(ws, "2026-08-19T10:00:00.000Z", 120, 30),
    ledgerRow(ws, "2026-08-19T11:00:00.000Z", 200, 50),
  ];

  const first = await runReporterOnce({ query: ledger(rows).query, billing, now });
  assert.deepEqual(first, { events: 2, inserted: 2, duplicates: 0 });

  // The whole point: a second run — a retry, a second replica, a deploy that
  // replayed the tick — sends the same two windows and inserts nothing. This is
  // why there is no send-log and no watermark to keep correct.
  const second = await runReporterOnce({ query: ledger(rows).query, billing, now });
  assert.deepEqual(second, { events: 2, inserted: 0, duplicates: 2 });

  // Same events, byte-for-byte, both times — the ids are what dedup keys on.
  assert.deepEqual(
    sent[0].map((event) => event.externalId),
    sent[1].map((event) => event.externalId),
  );
});

test("an open window is never sent — dedup makes the first send final", async () => {
  const { runReporterOnce } = await loadReporter();
  const { sent, billing } = tapped();
  const ws = "ws_open";
  const now = new Date("2026-08-19T12:30:00.000Z");
  // 12:00 is the hour ingest is writing into right now; the query returns it
  // (the 24h floor is all the SQL bounds) and the reporter must drop it. Were
  // it sent, Polar would hold that partial count forever: the correction
  // carries the same external id and would be skipped as a duplicate.
  const run = await runReporterOnce({
    query: ledger([
      ledgerRow(ws, "2026-08-19T11:00:00.000Z", 10, 5),
      ledgerRow(ws, "2026-08-19T12:00:00.000Z", 7, 3),
    ]).query,
    billing,
    now,
  });

  assert.equal(run.events, 1);
  assert.deepEqual(
    sent[0].map((event) => event.externalId),
    [`usage:${ws}:2026-08-19T11:00:00.000Z`],
  );
});

test("the settle margin is five minutes past the window end, inclusive", async () => {
  const { runReporterOnce } = await loadReporter();
  const windowStart = "2026-08-19T11:00:00.000Z";
  const windowEnd = new Date("2026-08-19T12:00:00.000Z").getTime();

  // A second short of the margin: the hour is over, but a late 5s flush can
  // still land in it, so it is not final yet.
  const early = tapped();
  const tooEarly = await runReporterOnce({
    query: ledger([ledgerRow("ws_settle_a", windowStart, 1, 1)]).query,
    billing: early.billing,
    now: new Date(windowEnd + 5 * 60 * 1000 - 1000),
  });
  assert.deepEqual(tooEarly, { events: 0, inserted: 0, duplicates: 0 });
  assert.equal(early.sent.length, 0, "an unsettled window is not even a call");

  // Exactly at the margin: end + 5m ≤ now, so it is closed (D170).
  const onTime = tapped();
  const settled = await runReporterOnce({
    query: ledger([ledgerRow("ws_settle_b", windowStart, 1, 1)]).query,
    billing: onTime.billing,
    now: new Date(windowEnd + 5 * 60 * 1000),
  });
  assert.equal(settled.events, 1);
});

test("the event carries the ruled shape: id, name, window-end timestamp, metadata", async () => {
  const { runReporterOnce, USAGE_EVENT_NAME } = await loadReporter();
  const { sent, billing } = tapped();
  const ws = "ws_shape";
  await runReporterOnce({
    query: ledger([ledgerRow(ws, "2026-08-19T09:00:00.000Z", 120, 30)]).query,
    billing,
    now: new Date("2026-08-19T12:30:00.000Z"),
  });

  const [event] = sent[0];
  // Pinned literally: this string IS the dedup key, so a change to how it is
  // built would silently re-send every window in the last 24h as new usage.
  assert.equal(event.externalId, `usage:${ws}:2026-08-19T09:00:00.000Z`);
  assert.equal(event.name, USAGE_EVENT_NAME);
  assert.equal(event.name, "ingest.events");
  // One Polar customer per workspace (D110) — the workspace id IS the external
  // customer, so no customer table of ours has to be kept in step.
  assert.equal(event.externalCustomerId, ws);
  // Backdated to the window it describes, not to the moment we sent it.
  assert.equal(event.timestamp.toISOString(), "2026-08-19T10:00:00.000Z");
  assert.deepEqual(event.metadata, { spans: 120, logs: 30, events: 150 });
});

test("scope and posture: polar customers only, 24h floor, read-only and $-bound", async () => {
  const { runReporterOnce } = await loadReporter();
  const { billing } = tapped();
  const recorded = ledger([]);
  const now = new Date("2026-08-19T12:30:00.000Z");
  const run = await runReporterOnce({ query: recorded.query, billing, now });

  assert.deepEqual(run, { events: 0, inserted: 0, duplicates: 0 });

  const [call] = recorded.calls;
  // Free-tier usage never leaves our ledger (D170): no polar customer, no send.
  assert.match(call.sql, /polar_customer_id IS NOT NULL/);
  // D11: one SELECT, nothing interpolated, the only value bound as $1.
  assert.match(call.sql, /^\s*SELECT\b/);
  assert.ok(!/INSERT|UPDATE|DELETE/i.test(call.sql), "the reporter never writes");
  assert.match(call.sql, /l\.period_start >= \$1/);
  assert.deepEqual(call.params, [new Date(now.getTime() - 24 * HOUR_MS)]);
});

test("nothing closed is not an empty batch — the rail is not called at all", async () => {
  const { runReporterOnce } = await loadReporter();
  const { sent, billing } = tapped();
  const run = await runReporterOnce({
    query: ledger([ledgerRow("ws_empty", "2026-08-19T12:00:00.000Z", 9, 9)]).query,
    billing,
    now: new Date("2026-08-19T12:30:00.000Z"),
  });
  assert.deepEqual(run, { events: 0, inserted: 0, duplicates: 0 });
  assert.equal(sent.length, 0);
});

test("fake billing starts no interval — CI and local dev never meter (D170)", async () => {
  const { startUsageReporter } = await loadReporter();
  // This process is live data mode, so the billing gate is the one under test:
  // the default rail is the fake, and the fake has no Polar to report to.
  assert.equal(startUsageReporter(), undefined);
});

// Both Polar rails meter: the sandbox evidence run and production run the same
// reporter, so the gate is asked through `isPolar` and not through a comparison
// against one rail — a production deployment that silently never metered is the
// failure this pair exists to exclude (D338).
for (const mode of ["polar-sandbox", "polar"] as const) {
  test(`${mode} in live mode starts the 5-minute interval, unref'd`, async () => {
    const { startUsageReporter, REPORTER_INTERVAL_MS } = await loadReporter();
    assert.equal(REPORTER_INTERVAL_MS, 5 * 60 * 1000);

    process.env.OBSTACK_BILLING_MODE = mode;
    try {
      const timer = startUsageReporter();
      assert.ok(timer, `${mode} is a configuration that meters`);
      // Unref'd: a periodic report is not a reason for a process to stay alive.
      assert.equal(timer.hasRef(), false);
      clearInterval(timer);
    } finally {
      delete process.env.OBSTACK_BILLING_MODE;
    }
  });
}
