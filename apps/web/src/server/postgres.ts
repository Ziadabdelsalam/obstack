import "server-only";
import { Pool, type QueryResultRow } from "pg";

/**
 * The product store: workspaces, saved views, and the better-auth tables — all
 * three owned by `services/ingest/pgmigrations` (D95), never migrated from
 * here. This module is the ClickHouse client's counterpart on the Postgres
 * side and keeps the same shape: one lazily built connection, one read path,
 * values bound as parameters and never interpolated (D11).
 *
 * Lazy on purpose (D114): mock mode must run with no Postgres present at all,
 * so nothing may connect at module load — the pool appears on the first query
 * a live-mode request makes.
 */
let pool: Pool | undefined;

/**
 * The one pool. better-auth takes this object directly as its `database`, so
 * its sessions and ours share a single connection budget.
 */
export function getPool(): Pool {
  if (!pool) {
    const dsn = process.env.OBSTACK_POSTGRES_DSN;
    if (!dsn) throw new Error("OBSTACK_POSTGRES_DSN is required when OBSTACK_DATA_MODE=live");
    pool = new Pool({ connectionString: dsn, application_name: "obstack-web" });
  }
  return pool;
}

/** The single read path: `$1`-bound values only, exactly `queryRows`' ClickHouse rule. */
export async function queryRows<Row extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  const result = await getPool().query<Row>(sql, params);
  return result.rows;
}

/**
 * The read path as a value, so a caller can be handed one instead of importing
 * it — the same "no ambient store" rule the scoped ClickHouse client follows
 * (D113), and what lets `resolveSessionContext` be unit-tested with no server.
 */
export type QueryRows = typeof queryRows;

/**
 * The one method the signup transaction needs from a checked-out client. A
 * structural type rather than `pg`'s `PoolClient` so the D117 contract test can
 * hand `provisionOrgAndWorkspace` a client whose workspace INSERT fails on
 * demand — a property about a failed statement has no other way to be proven.
 */
export type SqlClient = {
  query(sql: string, params?: unknown[]): Promise<unknown>;
};

/**
 * The one serialization idiom in the codebase (D195/D197): a workspace-keyed
 * advisory lock a read-modify-write takes so two of them cannot interleave.
 *
 * `pg_advisory_xact_lock` is TRANSACTION-scoped — it releases on COMMIT/ROLLBACK
 * and needs no unlock, which is the whole reason it is the primitive here: a
 * session lock leaked by a crashed handler would wedge a workspace forever. It
 * therefore only serializes when the `query` it runs on is bound to a
 * transaction (see `withTransaction`); through the plain pool it locks and
 * releases inside one implicit transaction and serializes nothing. `hashtext`
 * folds the workspace id to the `bigint` the lock keys on, so every holder of
 * the same workspace waits on the same key. Both billing convergence (F6) and
 * the override cap (F9) take exactly this lock before their read→write.
 */
export async function lockWorkspace(query: QueryRows, workspaceId: string): Promise<void> {
  await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [workspaceId]);
}

/**
 * Run `body` inside one transaction on a single checked-out connection, and
 * hand it a `query` bound to that connection so every statement it issues —
 * including a `lockWorkspace` — shares the transaction and its lock. COMMIT on
 * success, ROLLBACK on any throw (the same posture `provisionOrgAndWorkspace`
 * keeps). This is what lets an advisory lock actually serialize a read→write:
 * the caller reads the rail and writes the plan row between BEGIN and COMMIT,
 * so the lock is held across both.
 */
export async function withTransaction<T>(body: (query: QueryRows) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const query: QueryRows = async <Row extends QueryResultRow>(
      sql: string,
      params: unknown[] = [],
    ): Promise<Row[]> => (await client.query<Row>(sql, params)).rows;
    const result = await body(query);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // A ROLLBACK that itself fails means the connection is already gone; the
    // statement that threw is the reportable one, so this catch is swallowed.
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
