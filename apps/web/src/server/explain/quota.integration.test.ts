import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { getPool, queryRows } from "@/server/postgres";
import { getExplainQuota, spendExplainRun } from "./quota";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// What this file proves that no unit test can (D130): the D225 statement is
// ATOMIC, and Postgres agrees with the quota definition the product reads. The
// claims:
//
//   1. `0006_explain_quota.sql` landed: `plans.explain_quota` is 20 free / 200
//      pro (D226) and `explain_runs` exists — read raw, so nothing below is a
//      tautology against the TypeScript.
//   2. Absent `workspace_plans` row = free's quota, zero used — the D163 join.
//   3. A run spends exactly one, and the number `spendExplainRun` reports is the
//      number the next read sees.
//   4. The cap holds: the run after the last one is REFUSED, states the pair it
//      refused against, and leaves the row untouched.
//   5. Concurrency — the claim the whole single-statement design exists for:
//      runs fired in parallel against a quota of N grant exactly N. A
//      read-then-write would grant more, and this test is what would catch it.
//   6. A zero-quota plan refuses its FIRST run of the month (the INSERT arm's
//      guard — the ON CONFLICT arm never sees that row).
//   7. The window is the calendar month: last month's row is proven PRESENT and
//      proven not to count (S3.1 L1, content-aware).
//   8. A plan row moves the quota to that catalog row — 200 is not in TypeScript.
//   9. One workspace's runs never enter another's count.
//
// D130's skip class, deliberately NARROW: this file self-skips only when
// `OBSTACK_TEST_POSTGRES_DSN` is UNSET. A DSN naming a dead port or an
// unmigrated database FAILS here, loudly. The schema is NOT applied here: the
// ingest binary's migrator applying `services/ingest/pgmigrations/*.sql` is the
// ONE schema path.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

// `postgres.ts` builds its pool lazily on the first query (D114), so pointing
// the app's own read path at the test DSN is enough.
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
 * The month as POSTGRES computes it — the same expression `quota.ts` writes
 * with. Never computed in JavaScript: a fixture built from this process's clock
 * and a row written by the server's would agree almost always and disagree
 * exactly at the boundary this test is about.
 */
const MONTH_START = `(date_trunc('month', now() AT TIME ZONE 'UTC'))::date`;

/** A fresh pair of workspaces for one test, dropped afterwards (`ON DELETE CASCADE` takes their rows). */
async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_t1a_${tag}`;
  const b = `ws_t1b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [
    a,
    `org_t1a_${tag}`,
    b,
    `org_t1b_${tag}`,
  ]);
  try {
    await run(a, b);
  } finally {
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

/** This month's counter row, read raw. */
async function counterRow(workspaceId: string) {
  const [row] = await queryRows<{ used: number }>(
    `SELECT used FROM explain_runs WHERE workspace_id = $1 AND period_start = ${MONTH_START}`,
    [workspaceId],
  );
  return row;
}

/** The catalog row, read raw — so a quota assertion below is never a tautology. */
async function catalogQuota(planId: string): Promise<number> {
  const [row] = await queryRows<{ explain_quota: number }>(
    `SELECT explain_quota FROM plans WHERE id = $1`,
    [planId],
  );
  return row.explain_quota;
}

test("the DSN this run was given answers, and it holds 0006's schema", { skip }, async () => {
  // First contact. A refused connection or a missing table surfaces HERE, with
  // the address in the message, instead of inside a property test — never as a
  // skip.
  try {
    assert.deepEqual(
      await queryRows(`SELECT used FROM explain_runs WHERE workspace_id = $1`, [
        `ws_t1_absent_${randomBytes(4).toString("hex")}`,
      ]),
      [],
    );
  } catch (error) {
    assert.fail(
      `OBSTACK_TEST_POSTGRES_DSN is set but ${target()} did not answer a read of explain_runs — ` +
        `an integration test with a DSN never degrades to a pass; apply ` +
        `services/ingest/pgmigrations in filename order and check the port: ${String(error)}`,
    );
  }
});

test("D226: the catalog carries the Explain quota — 20 free, 200 pro", { skip }, async () => {
  // The numbers the landing page has been promising are now the catalog of
  // record. Nothing in TypeScript defines them, which is why this read is raw.
  assert.equal(await catalogQuota("free"), 20);
  assert.equal(await catalogQuota("pro"), 200);
});

test("a workspace with no plan row and no runs is on free's quota, at zero", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    // The premise, measured rather than assumed: there is no plan row, so the
    // COALESCE join is what puts this workspace on a quota.
    assert.deepEqual(
      await queryRows(`SELECT plan_id FROM workspace_plans WHERE workspace_id = $1`, [a]),
      [],
    );
    assert.deepEqual(await getExplainQuota(a, queryRows), {
      quota: await catalogQuota("free"),
      used: 0,
    });
    // ...and no counter row was created by reading.
    assert.equal(await counterRow(a), undefined);
  });
});

test("a run spends exactly one, and the number it reports is the stored one", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const first = await spendExplainRun(a, queryRows);
    assert.deepEqual(first, { allowed: true, quota: 20, used: 1 });
    assert.deepEqual(await counterRow(a), { used: 1 });

    const second = await spendExplainRun(a, queryRows);
    assert.deepEqual(second, { allowed: true, quota: 20, used: 2 });
    assert.deepEqual(await getExplainQuota(a, queryRows), { quota: 20, used: 2 });
  });
});

test("the run after the last one is refused, and spends nothing", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const quota = await catalogQuota("free");
    // Spent to the cap by the product's own path, one run at a time.
    for (let i = 0; i < quota; i += 1) {
      assert.equal((await spendExplainRun(a, queryRows)).allowed, true);
    }
    assert.deepEqual(await counterRow(a), { used: quota });

    const refused = await spendExplainRun(a, queryRows);
    // The refusal states the pair it refused against, so the surface can say
    // "20 of 20 used this month" rather than raising an error.
    assert.deepEqual(refused, { allowed: false, quota, used: quota });
    // Content-aware: the row is proven UNCHANGED, not merely "not obviously
    // wrong" — a refused run that still incremented would read quota + 1.
    assert.deepEqual(await counterRow(a), { used: quota });
  });
});

test("D225: runs fired in parallel grant exactly the quota, never more", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    const quota = await catalogQuota("free");
    // Twice the quota, all in flight. This is the property the single-statement
    // design exists for: a read-then-write would let several callers see the
    // same "19 used" and each spend the twentieth run. Replace SPEND_SQL with a
    // SELECT followed by an UPDATE and this line goes red.
    const outcomes = await Promise.all(
      Array.from({ length: quota * 2 }, () => spendExplainRun(a, queryRows)),
    );

    assert.equal(outcomes.filter((outcome) => outcome.allowed).length, quota);
    assert.equal(outcomes.filter((outcome) => !outcome.allowed).length, quota);
    assert.deepEqual(await counterRow(a), { used: quota });
    // Every granted run got a distinct position in the month — no two callers
    // were told they were the same run.
    const granted = outcomes.filter((outcome) => outcome.allowed).map((outcome) => outcome.used);
    assert.deepEqual([...granted].sort((x, y) => x - y), [...Array(quota).keys()].map((i) => i + 1));
  });
});

test("a plan whose quota is zero refuses its FIRST run of the month", { skip }, async () => {
  const tag = randomBytes(6).toString("hex");
  const planId = `test_zero_${tag}`;
  await queryRows(
    `INSERT INTO plans (id, name, event_quota, retention_days, price_usd_month, explain_quota)
          VALUES ($1, 'Zero (test)', 1, 1, 0, 0)`,
    [planId],
  );
  try {
    await withWorkspacePair(async (a) => {
      await queryRows(`INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ($1, $2)`, [
        a,
        planId,
      ]);
      // The INSERT arm's own guard: with no row yet there is nothing for the ON
      // CONFLICT arm's cap to refuse, so a zero quota would otherwise create the
      // row at used = 1 and hand out a run the plan does not include.
      assert.deepEqual(await spendExplainRun(a, queryRows), { allowed: false, quota: 0, used: 0 });
      assert.equal(await counterRow(a), undefined);
    });
  } finally {
    await queryRows(`DELETE FROM plans WHERE id = $1`, [planId]);
  }
});

test("the month window excludes a row that is IN the table but before it", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    await queryRows(
      `INSERT INTO explain_runs (workspace_id, period_start, used)
            VALUES ($1, ${MONTH_START} - interval '1 month', 999)`,
      [a],
    );
    // Content-aware (S3.1 L1): the excluded row is proven to EXIST and to hold a
    // number that would swamp the answer, so "0 used" is a fact about the window
    // rather than about a row that never landed.
    assert.deepEqual(
      await queryRows<{ used: number }>(
        `SELECT used FROM explain_runs WHERE workspace_id = $1 AND period_start < ${MONTH_START}`,
        [a],
      ),
      [{ used: 999 }],
    );

    assert.deepEqual(await getExplainQuota(a, queryRows), { quota: 20, used: 0 });
    // ...and this month's first run starts this month's own row at 1.
    assert.deepEqual(await spendExplainRun(a, queryRows), { allowed: true, quota: 20, used: 1 });
  });
});

test("a plan row moves the quota to that catalog row", { skip }, async () => {
  await withWorkspacePair(async (a) => {
    await spendExplainRun(a, queryRows);
    const onFree = await getExplainQuota(a, queryRows);

    await queryRows(`INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ($1, 'pro')`, [a]);
    const onPro = await getExplainQuota(a, queryRows);

    assert.equal(onPro.quota, await catalogQuota("pro"));
    assert.notEqual(onPro.quota, onFree.quota);
    // The plan changed what the count is measured AGAINST and not the count:
    // one counter, whatever it is billed against.
    assert.equal(onPro.used, onFree.used);
    assert.equal(onPro.used, 1);
  });
});

test("one workspace's runs never enter another's count", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    assert.notEqual(a, b);
    await spendExplainRun(a, queryRows);
    await spendExplainRun(a, queryRows);
    await spendExplainRun(b, queryRows);

    assert.equal((await getExplainQuota(a, queryRows)).used, 2);
    assert.equal((await getExplainQuota(b, queryRows)).used, 1);
  });
});
