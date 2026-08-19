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
