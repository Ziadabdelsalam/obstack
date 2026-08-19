import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { OVERRIDE_MAX, upsertPricingOverride } from "./ingest-health";
import type { QueryRows } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// QA A4, area: settings Data & ingest tab + pricing-override CRUD, hostile input.
//
// The unit file `ingest-health.test.ts` proves the cap SQL *reads* the way it
// should against a recording fake — `count(*) FROM pricing_overrides ... < $6`
// inside the INSERT. Its docstring names the reason the count lives inside the
// statement rather than in a SELECT before it:
//
//   "two statements are two moments: two tabs at ninety-nine overrides would
//    both read ninety-nine and both write."
//
// This is the destructive complement it does not have: the cap run against real
// Postgres with the two tabs actually concurrent. A count-subquery inside one
// INSERT is still ONE READ COMMITTED snapshot — it does not see rows other
// transactions have inserted but not committed — so two overlapping creates at
// the boundary both count `cap-1`, both pass the `< cap` guard, and both write.
// One statement did not make the two moments one.
//
// Reproduced against the running product first (direct POST to the saveOverride
// server action on the live build): a workspace seeded to 99 overrides took 8
// concurrent posts up to 106-107 rows, and from 95 rows a burst of 20 reached
// 101. Through a plain connection pool the calls serialise and the window
// closes; this test opens the window deterministically by holding each create's
// transaction open until every sibling has executed its INSERT, which is what
// two browser tabs submitting at once genuinely do. `upsertPricingOverride`
// takes an INJECTED `QueryRows` (the D113 seam), so the product statement is the
// thing under test and only the commit timing is the test's.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;
const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

const pool = DSN ? new Pool({ connectionString: DSN, max: 24, application_name: "qa-a4" }) : undefined;

after(async () => {
  if (pool) await pool.end();
});

const q = (client: Pool | PoolClient): QueryRows =>
  async <Row extends QueryResultRow>(sql: string, params: unknown[] = []): Promise<Row[]> =>
    (await client.query<Row>(sql, params)).rows;

/** A fresh workspace for one test, dropped afterwards (random suffix, per T3's note). */
async function withWorkspace(run: (ws: string, query: QueryRows) => Promise<void>): Promise<void> {
  const query = q(pool as Pool);
  const tag = randomBytes(6).toString("hex");
  const ws = `ws_a4c_${tag}`;
  await query(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [ws, `org_a4c_${tag}`]);
  try {
    await run(ws, query);
  } finally {
    await query(`DELETE FROM workspaces WHERE id = $1`, [ws]); // CASCADE drops the overrides
  }
}

async function overrideCount(query: QueryRows, ws: string): Promise<number> {
  const [row] = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pricing_overrides WHERE workspace_id = $1`,
    [ws],
  );
  return Number(row.n);
}

test("the DSN answers and pricing_overrides is migrated", { skip }, async () => {
  const [row] = await q(pool as Pool)<{ n: string }>(
    `SELECT count(*)::text AS n FROM pricing_overrides`,
  );
  assert.equal(typeof row.n, "string", "pricing_overrides did not answer a count");
});

test(
  "B4-1: the D164(f) cap holds when creates at the boundary overlap",
  { skip },
  async () => {
    await withWorkspace(async (ws, query) => {
      // Seed to one below the cap. The fill is not under test — the boundary is.
      const seed = OVERRIDE_MAX - 1;
      for (let i = 0; i < seed; i++) {
        await query(
          `INSERT INTO pricing_overrides (id, workspace_id, match, input_per_mtok, output_per_mtok)
           VALUES ($1, $2, $3, 1, 2)`,
          [`pov_a4seed${String(i).padStart(9, "0")}`, ws, `seed-${String(i).padStart(3, "0")}`],
        );
      }
      assert.equal(await overrideCount(query, ws), seed, "seed did not land");

      // Eight overlapping creates — distinct matches, so every one is a CREATE
      // the cap must weigh. Each runs `upsertPricingOverride` inside its own
      // held-open transaction; a barrier keeps every transaction from committing
      // until all eight have executed their INSERT, so all eight take the
      // `count(*)` under the same snapshot that shows `seed` and none sees the
      // others. This is two-plus tabs clicking "Set price" at once, made
      // deterministic instead of left to a scheduler.
      const N = 8;
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));

      const clients = await Promise.all(Array.from({ length: N }, () => (pool as Pool).connect()));
      const creates = clients.map(async (client, i) => {
        await client.query("BEGIN");
        try {
          await upsertPricingOverride(
            ws,
            { match: `race-${String(i).padStart(3, "0")}`, inputPerMTok: 1, outputPerMTok: 2 },
            q(client),
          );
          if (++arrived === N) release();
          await gate; // hold the row uncommitted until every sibling has inserted
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      });
      await Promise.allSettled(creates);

      const rows = await overrideCount(query, ws);
      // The bound is D164(f)'s whole point: the ingest keystore loads EVERY
      // override row of a workspace into its cached per-workspace price table on
      // each refresh (`keystore/store.go` overridesSQL — no LIMIT), so a
      // workspace that grows past the cap grows that table with no bound. The
      // store must refuse the create that would exceed OVERRIDE_MAX no matter
      // how many arrive at once.
      assert.ok(
        rows <= OVERRIDE_MAX,
        `pricing_overrides for ${ws} holds ${rows} rows — past the ${OVERRIDE_MAX} cap. ` +
          `${N} creates from ${seed} all passed the in-INSERT count(*) because it is one ` +
          `READ COMMITTED snapshot and their inserts were mutually invisible: the ` +
          `single statement did not make "two tabs at ninety-nine" one moment.`,
      );
    });
  },
);
