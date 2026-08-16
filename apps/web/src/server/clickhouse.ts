import "server-only";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

/** Fixed by services/ingest/migrations — the schema owner, not a deployment knob. */
const DATABASE = "obstack";

/**
 * Phase 1 is single-tenant: every query binds the workspace the dev API key
 * writes under (compose default `OBSTACK_API_KEYS=ok_dev_local:ws_demo`).
 * Workspaces become request-scoped with auth in M3.
 */
export const workspaceId = process.env.OBSTACK_WORKSPACE_ID ?? "ws_demo";

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
 * The single read path. Values are always bound through `query_params` —
 * no SQL is ever built by interpolation (D11).
 *
 * The web user is `readonly=2` and holds no `system.*` grants, so nothing here
 * may introspect the server (schema discovery would fail with ACCESS_DENIED).
 */
export async function queryRows<Row>(
  query: string,
  params: Record<string, unknown>,
): Promise<Row[]> {
  const result = await getClient().query({
    query,
    query_params: params,
    format: "JSONEachRow",
  });
  return result.json<Row>();
}
