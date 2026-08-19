import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { getPool, queryRows } from "./postgres";
import { getUsage, listPlans } from "./usage";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// What this file proves that no unit test can (D130): `getUsage` is ONE
// definition and Postgres agrees with it. The claims:
//
//   1. Absent `workspace_plans` row = free, with the catalog's own numbers —
//      the COALESCE join, run against a workspace that really has no plan row.
//   2. The month window is real: a bucket one hour before the month start is
//      proven PRESENT in the table and absent from the sum (S3.1 L1 — the
//      exclusion is asserted by content, not by a number that happens to match).
//   3. `SUM(spans + logs)` counts a span and a log record alike (PRD §10).
//   4. `asOf` is the freshest `updated_at` IN the window, and null when the
//      workspace has never metered — "no events yet", not the epoch.
//   5. A plan row moves quota, retention and name to that catalog row — none of
//      those three numbers exists in TypeScript (D163).
//   6. Another workspace's ledger rows never enter this workspace's sum.
//   7. The seeded catalog IS the D163 catalog of record, read through the same
//      path the billing surface reads it through.
//
// D130's skip class, deliberately NARROW: this file self-skips only when
// `OBSTACK_TEST_POSTGRES_DSN` is UNSET. A DSN naming a dead port or an
// unmigrated database FAILS here, loudly — an integration test with a DSN never
// degrades to a pass. The schema is NOT applied here: the ingest binary's
// migrator applying `services/ingest/pgmigrations/*.sql` is the ONE schema path.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

// `postgres.ts` builds its pool lazily on the first query (D114), so pointing the
// app's own read path at the test DSN is enough: `getUsage` is called below with
// `queryRows`, the same injected read path the settings page hands it.
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

after(async () => {
  if (DSN) await getPool().end();
});

/** host:port of the DSN, for failure messages — never its password. */
function target(): string {
  try {
    const url = new URL(DSN as string);
    return `${url.host}${url.pathname}`;
  } catch {
    return "the configured DSN";
  }
}

/**
 * The month boundary as POSTGRES computes it — the same expression `usage.ts`
 * windows on. The test must not compute the boundary in JavaScript: a fixture
 * built from this process's clock and a query windowed by the server's would
 * agree almost always and disagree exactly at the boundary this test is about.
 */
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

/**
 * A ledger bucket `offsetHours` from the month start. Positive offsets are
 * inside the window, negative ones are the previous month — the row that must
 * exist and must not count.
 */
async function meter(
  workspaceId: string,
  offsetHours: number,
  spans: number,
  logs: number,
  updatedAt?: string,
): Promise<void> {
  await queryRows(
    `INSERT INTO usage_ledger (workspace_id, period_start, spans, logs, updated_at)
          VALUES ($1, ${MONTH_START} + make_interval(hours => $2::int), $3, $4,
                  coalesce($5::timestamptz, now()))`,
    [workspaceId, offsetHours, spans, logs, updatedAt ?? null],
  );
}

/**
 * A fresh pair of workspaces for one test, dropped afterwards. Random ids
 * because CI runs this against a compose Postgres other drives also write to: a
 * fixed id would collide with a rerun, and a global DELETE would take somebody
 * else's rows with it. `ON DELETE CASCADE` takes the ledger and plan rows.
 */
async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_t6a_${tag}`;
  const b = `ws_t6b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [
    a,
    `org_t6a_${tag}`,
    b,
    `org_t6b_${tag}`,
  ]);
  try {
    await run(a, b);
  } finally {
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

/** The catalog row, read raw — so a plan assertion below is never a tautology. */
async function catalog(planId: string) {
  const [row] = await queryRows<{
    name: string;
    event_quota: string;
    retention_days: number;
  }>(`SELECT name, event_quota, retention_days FROM plans WHERE id = $1`, [planId]);
  return row;
}

test("the DSN this run was given answers, and it holds the metering schema", { skip }, async () => {
  // First contact. A refused connection or a missing table surfaces HERE, with
  // the address in the message, instead of inside a property test — and never
  // as a skip.
  try {
    assert.deepEqual(
      await queryRows(`SELECT workspace_id FROM usage_ledger WHERE workspace_id = $1`, [
        `ws_t6_absent_${randomBytes(4).toString("hex")}`,
      ]),
      [],
    );
  } catch (error) {
    assert.fail(
      `OBSTACK_TEST_POSTGRES_DSN is set but ${target()} did not answer a read of usage_ledger — ` +
        `an integration test with a DSN never degrades to a pass; apply ` +
        `services/ingest/pgmigrations in filename order and check the port: ${String(error)}`,
    );
  }
});

test("D163: the seeded catalog is the plan catalog of record", { skip }, async () => {
  // The numbers the landing page and the mock suite show became real pricing on
  // this sprint's user notice. Nothing in TypeScript defines them — this read is
  // the whole definition reaching the product, so it is pinned here.
  assert.deepEqual(await listPlans(queryRows), [
    { id: "free", name: "Free", eventQuota: 50000, retentionDays: 7, priceUsdMonth: 0 },
    { id: "pro", name: "Pro", eventQuota: 1000000, retentionDays: 30, priceUsdMonth: 49 },
  ]);
});

test("a workspace with no plan row and no events is on free, at zero", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    // The premise, measured rather than assumed: there is no plan row. The
    // COALESCE join is what puts this workspace on a plan, so if a row existed
    // the assertion below would prove nothing about it.
    assert.deepEqual(
      await queryRows(`SELECT plan_id FROM workspace_plans WHERE workspace_id = $1`, [a]),
      [],
    );

    const free = await catalog("free");
    const usage = await getUsage(a, queryRows);
    assert.equal(usage.planId, "free");
    assert.equal(usage.planName, free.name);
    assert.equal(usage.eventQuota, Number(free.event_quota));
    assert.equal(usage.retentionDays, free.retention_days);
    assert.equal(usage.eventsUsed, 0);
    // Never metered: there is no moment to state, and the surface says so
    // instead of dating the epoch.
    assert.equal(usage.asOf, null);
    // ...and the period really is the current UTC month, to the hour.
    assert.equal(usage.periodStart.getUTCDate(), 1);
    assert.equal(usage.periodStart.getUTCHours(), 0);
    assert.equal(usage.periodStart.getUTCMonth(), new Date().getUTCMonth());
  });
});

test("events are spans + log records, summed across the month's buckets", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    await meter(a, 0, 3, 0); // spans only
    await meter(a, 1, 0, 5); // log records only
    await meter(a, 2, 7, 11); // both

    const usage = await getUsage(a, queryRows);
    assert.equal(usage.eventsUsed, 3 + 5 + 7 + 11);
  });
});

test("the month window excludes a bucket that is IN the table but before it", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    await meter(a, -1, 1000, 1000); // last month's final hour
    await meter(a, 0, 4, 6);

    // Content-aware (S3.1 L1): the excluded row is proven to EXIST and to hold
    // the numbers that would swamp the answer, so "2000 is missing" is a fact
    // about the window rather than about a row that never landed.
    const [before] = await queryRows<{ spans: string; logs: string }>(
      `SELECT spans, logs FROM usage_ledger
        WHERE workspace_id = $1 AND period_start < ${MONTH_START}`,
      [a],
    );
    assert.deepEqual(before, { spans: "1000", logs: "1000" });

    assert.equal((await getUsage(a, queryRows)).eventsUsed, 10);
  });
});

test("asOf is the freshest ledger write in the window", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const older = "2026-08-01T09:00:00Z";
    const newest = "2026-08-01T11:30:00Z";
    await meter(a, 0, 1, 0, older);
    await meter(a, 1, 1, 0, newest);
    // A LATER write on a bucket OUTSIDE the window must not date the number the
    // surface is showing: "as of" answers for the sum beside it.
    await meter(a, -1, 1, 0, "2030-01-01T00:00:00Z");

    const usage = await getUsage(a, queryRows);
    assert.equal(usage.asOf?.toISOString(), new Date(newest).toISOString());
    assert.equal(usage.eventsUsed, 2);
  });
});

test("a plan row moves quota, retention and name to that catalog row", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    await meter(a, 0, 40, 2);
    const onFree = await getUsage(a, queryRows);

    await queryRows(`INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ($1, 'pro')`, [a]);
    const onPro = await getUsage(a, queryRows);

    const pro = await catalog("pro");
    assert.equal(onPro.planId, "pro");
    assert.equal(onPro.planName, pro.name);
    assert.equal(onPro.eventQuota, Number(pro.event_quota));
    assert.equal(onPro.retentionDays, pro.retention_days);
    // The plan changed what the usage is measured AGAINST and not the usage:
    // one ledger, one number, whatever is being billed for it (D110).
    assert.equal(onPro.eventsUsed, onFree.eventsUsed);
    assert.equal(onPro.eventsUsed, 42);
    assert.notEqual(onPro.eventQuota, onFree.eventQuota);
    assert.notEqual(onPro.retentionDays, onFree.retentionDays);
  });
});

test("one workspace's ledger never enters another's number", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    assert.notEqual(a, b);
    await meter(a, 0, 2, 3);
    await meter(b, 0, 500, 500);

    assert.equal((await getUsage(a, queryRows)).eventsUsed, 5);
    assert.equal((await getUsage(b, queryRows)).eventsUsed, 1000);

    // ...and a plan bought by one is not a plan the other is on.
    await queryRows(`INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ($1, 'pro')`, [b]);
    assert.equal((await getUsage(a, queryRows)).planId, "free");
    assert.equal((await getUsage(b, queryRows)).planId, "pro");
  });
});
