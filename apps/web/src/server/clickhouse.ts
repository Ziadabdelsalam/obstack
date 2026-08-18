import "server-only";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

/** Fixed by services/ingest/migrations — the schema owner, not a deployment knob. */
const DATABASE = "obstack";

/**
 * The telemetry read interface — and the only one this module hands out (D96).
 * Every statement it runs is bound to the one workspace `forWorkspace` was
 * called with; there is no unscoped client to reach for and no ambient
 * workspace to forget.
 */
export interface ScopedClickHouse {
  queryRows<Row>(sql: string, params?: Record<string, unknown>): Promise<Row[]>;
}

let client: ClickHouseClient | undefined;

function getClient(): ClickHouseClient {
  if (!client) {
    const url = process.env.CLICKHOUSE_URL;
    if (!url) throw new Error("CLICKHOUSE_URL is required when OBSTACK_DATA_MODE=live");
    client = createClient({
      url,
      username: process.env.CLICKHOUSE_USER ?? "obstack_web",
      password: process.env.CLICKHOUSE_PASSWORD ?? "",
      database: DATABASE,
      application: "obstack-web",
    });
  }
  return client;
}

/**
 * The placeholder every scoped statement must carry. It is a TEXT check on the
 * SQL, deliberately: the binding is injected below whether the caller asks for
 * it or not, so the only thing that can still leak is a statement whose WHERE
 * clause never reads it — a query that binds `workspace_id` and filters on
 * nothing would run against every tenant's rows.
 */
const WORKSPACE_PLACEHOLDER = "{workspace_id:";

/**
 * A statement on one line, clipped: enough for an error to name what it
 * refused. These skeletons are indented across many lines and several open with
 * a bare `SELECT`, so a first-line excerpt would name nothing.
 */
const summarize = (sql: string): string => sql.trim().replace(/\s+/g, " ").slice(0, 100);

/**
 * The single read path. Values are always bound through `query_params` — no SQL
 * is ever built by interpolation (D11) — and `workspace_id` is bound from the
 * SCOPE, never from the caller (D113).
 *
 * The two refusals are a runtime tripwire, not validation: an omitted tenancy
 * predicate is a cross-tenant read, which is strictly worse than any wrong
 * answer this product can give, so the query dies before it reaches the server
 * rather than returning another workspace's rows. Both clauses are proven red
 * in `tenancy.test.ts`.
 *
 * The web user is `readonly=2` and holds no `system.*` grants, so nothing here
 * may introspect the server (schema discovery would fail with ACCESS_DENIED).
 */
async function runScoped<Row>(
  workspaceId: string,
  sql: string,
  params: Record<string, unknown>,
): Promise<Row[]> {
  if (!sql.includes(WORKSPACE_PLACEHOLDER)) {
    throw new Error(
      `refusing unscoped SQL: no ${WORKSPACE_PLACEHOLDER}String} predicate in "${summarize(sql)}"`,
    );
  }
  const supplied = params.workspace_id;
  if (supplied !== undefined && supplied !== workspaceId) {
    throw new Error(
      `refusing a caller-supplied workspace_id (${JSON.stringify(supplied)}) that is not this scope's (${JSON.stringify(workspaceId)})`,
    );
  }
  const result = await getClient().query({
    query: sql,
    query_params: { ...params, workspace_id: workspaceId },
    format: "JSONEachRow",
  });
  return result.json<Row>();
}

/**
 * The ONE way to obtain the telemetry query interface (D96/D113). There is no
 * default workspace and no env fallback: the workspace is a request-scoped
 * value the caller must already know — a session's active workspace in the
 * product, a literal in the harnesses and tests that seeded it.
 *
 * An empty or whitespace id is refused here rather than passed down, because
 * `workspace_id = ''` is a legal ClickHouse predicate that quietly reads the
 * rows of every sender that arrived without a workspace.
 */
export function forWorkspace(workspaceId: string): ScopedClickHouse {
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    throw new Error(
      `forWorkspace requires a workspace id, got ${JSON.stringify(workspaceId)}`,
    );
  }
  return {
    queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
      return runScoped<Row>(workspaceId, sql, params);
    },
  };
}
