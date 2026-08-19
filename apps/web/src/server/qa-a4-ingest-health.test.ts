import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { OVERRIDE_MAX, OverrideLimit, upsertPricingOverride } from "./ingest-health";
import { getPool, queryRows, withTransaction, type QueryRows } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// QA A4, area: settings Data & ingest tab + pricing-override CRUD, hostile input.
//
// The unit file `ingest-health.test.ts` proves the cap statements READ the way
// they should against a recording fake — the workspace advisory lock is taken
// FIRST, then `count(*) FROM pricing_overrides ... < $6` inside the INSERT. This
// is the destructive complement it cannot have: the cap run against real
// Postgres with two-plus tabs actually concurrent.
//
// A count-subquery inside one INSERT is still ONE READ COMMITTED snapshot — it
// does not see rows other transactions have inserted but not committed — so two
// overlapping creates at the boundary both count `cap-1`, both pass the `< cap`
// guard, and both write. One statement did not make the two moments one. That
// was B4-1, reproduced against the running product first: a workspace seeded to
// 99 overrides took 8 concurrent posts up to 106-107 rows.
//
// D197's fix is `pg_advisory_xact_lock(hashtext(workspace_id))` taken inside the
// caller's transaction BEFORE the count→insert (`saveOverride` runs the store
// inside `withTransaction`). The second create to arrive blocks in
// `lockWorkspace` until the first commits, then counts the committed row and is
// refused. So the guard is: fire N genuinely concurrent creates through the real
// product path — each its own transaction on its own pooled connection, exactly
// the shape `withTransaction` gives `saveOverride` — against a workspace one
// below the cap, and exactly one may win.
//
// The creates SYNCHRONISE on a start barrier that releases when every one has
// BEGUN — never when every one has inserted. That is the whole distinction from
// the deadlocking method: aligning the moment they FIRE their upsert makes their
// READ COMMITTED snapshots overlap (so without the lock all N count `cap-1` and
// all write — measured RED 8/8), while gating on "begun" rather than "inserted"
// means a create can always run to COMMIT/ROLLBACK on its own. Against the real
// lock the losers simply block in `lockWorkspace` after the barrier — no worker
// waits on the barrier while holding the lock, so nothing deadlocks. Red before
// the fix (the count climbs past the cap), green after (the lock serializes them
// and the losers are refused at the boundary).

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;
const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

const pool = DSN ? new Pool({ connectionString: DSN, max: 24, application_name: "qa-a4" }) : undefined;

// The concurrent creates drive the PRODUCTION door `withTransaction`, which
// opens each transaction on the MODULE pool (`getPool`) — the only source of the
// `TxQuery` `upsertPricingOverride` now demands (D199) — so this dials the same
// test Postgres and the pool is closed alongside ours below.
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

after(async () => {
  if (pool) await pool.end();
  if (DSN) await getPool().end();
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

/**
 * One create through the REAL product path: `withTransaction` opens a
 * transaction on its own pooled connection and hands `upsertPricingOverride` the
 * `TxQuery` the store's advisory lock demands (D199), COMMIT on success and
 * ROLLBACK on the cap — byte-for-byte what `saveOverride` does. `arrive` reports
 * that this create has BEGUN (the body runs after `withTransaction`'s BEGIN) and
 * `gate` releases every create's upsert together (the start barrier). The cap
 * refusal is `OverrideLimit`, the store's own class, and every other failure propagates so a
 * real error cannot masquerade as a loser.
 */
async function createInTransaction(
  ws: string,
  match: string,
  arrive: () => void,
  gate: Promise<void>,
): Promise<"won" | "capped"> {
  try {
    await withTransaction(async (query) => {
      arrive(); // this create has BEGUN — the barrier gates on this, not on the insert
      await gate; // fire every create's upsert at once, so their snapshots overlap
      await upsertPricingOverride(ws, { match, inputPerMTok: 1, outputPerMTok: 2 }, query);
    });
    return "won";
  } catch (error) {
    // `withTransaction` already ran ROLLBACK on the throw; the cap refusal is the
    // store's own `OverrideLimit`, and every other failure propagates so a real
    // error cannot masquerade as a loser.
    if (error instanceof OverrideLimit) return "capped";
    throw error;
  }
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
      // One below the cap: exactly one of the concurrent creates may fill the
      // last slot. The fill is not under test — the boundary is.
      const seed = OVERRIDE_MAX - 1;
      for (let i = 0; i < seed; i++) {
        await query(
          `INSERT INTO pricing_overrides (id, workspace_id, match, input_per_mtok, output_per_mtok)
           VALUES ($1, $2, $3, 1, 2)`,
          [`pov_a4seed${String(i).padStart(9, "0")}`, ws, `seed-${String(i).padStart(3, "0")}`],
        );
      }
      assert.equal(await overrideCount(query, ws), seed, "seed did not land");

      // Eight genuinely concurrent creates — distinct matches, so every one is a
      // CREATE the cap must weigh, each on its own `withTransaction` connection
      // (the module pool's default ceiling is 10, and every worker parks on the
      // barrier holding its connection). The start barrier releases the instant
      // all eight have BEGUN, so every upsert fires together and their READ
      // COMMITTED snapshots overlap: this is many browser tabs clicking "Set
      // price" at the same moment. Without the lock they race the single snapshot
      // and the count climbs past the cap; with it they serialize and only one
      // may fill the last slot.
      const N = 8;
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const arrive = () => {
        if (++arrived === N) release();
      };
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          createInTransaction(ws, `race-${String(i).padStart(3, "0")}`, arrive, gate),
        ),
      );
      const won = results.filter((r) => r === "won").length;
      const capped = results.filter((r) => r === "capped").length;

      const rows = await overrideCount(query, ws);
      // The bound is D164(f)'s whole point: the ingest keystore loads EVERY
      // override row of a workspace into its cached per-workspace price table on
      // each refresh (`keystore/store.go` overridesSQL — ORDER BY match LIMIT
      // 100 after F7, the D197 read-side pin), so a workspace that grows past the
      // cap grows that table with no bound. The store must refuse every create
      // that would exceed OVERRIDE_MAX no matter how many arrive at once.
      assert.ok(
        rows <= OVERRIDE_MAX,
        `pricing_overrides for ${ws} holds ${rows} rows — past the ${OVERRIDE_MAX} cap. ` +
          `${N} creates from ${seed} all passed the in-INSERT count(*) because it is one ` +
          `READ COMMITTED snapshot and their inserts were mutually invisible: the advisory ` +
          `lock did not serialize the read→write.`,
      );
      // Seeded one below the cap, so exactly one create fills the last slot and
      // every other is refused at the boundary — the cap is enforced, not merely
      // survived. `won + capped === N` proves no create failed for another reason.
      assert.equal(rows, OVERRIDE_MAX, `the last slot was not filled exactly once: ${rows} rows`);
      assert.equal(won, 1, `expected exactly one winner, got ${won}`);
      assert.equal(capped, N - 1, `expected ${N - 1} creates refused at the cap, got ${capped}`);
    });
  },
);

// --------------------------------------------------------------------------
// D199 — the compile-refusal proof for the override write. `upsertPricingOverride`
// demands a `TxQuery`, the brand only `withTransaction` mints, so a plain pooled
// `queryRows` (through which the cap's advisory lock would serialize nothing) is
// not assignable and the cap cannot silently re-open on an unwrapped caller. This
// arrow is DEFINED and never invoked: `next build` type-checks it (tsc over
// `**/*.ts`), so the `@ts-expect-error` must fire or the build fails with an
// unused-directive error; `tsx` strips the types and never calls it at runtime.
// --------------------------------------------------------------------------
void (async (): Promise<void> => {
  // @ts-expect-error a plain pooled `queryRows` is not the branded `TxQuery`
  await upsertPricingOverride("ws", { match: "m", inputPerMTok: 1, outputPerMTok: 2 }, queryRows);
});
