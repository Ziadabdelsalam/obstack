import { redirect } from "next/navigation";
import { connection } from "next/server";
import { McpLive } from "@/components/mcp/McpLive";
import { McpPage } from "@/components/mcp/McpPage";
import { MCP_ADMITTED_SCOPES } from "@/lib/mcp-types";
import { listApiKeys } from "@/server/api-keys";
import { dataMode } from "@/server/data";
import { resolveMcpEndpoint } from "@/server/mcp-endpoint";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The MCP page, live-wired (S8.1 T5, D652) in the incidents page's D431/D519
 * shape: the mock branch returns the frozen page body (`McpPage`, byte-pinned
 * by `page.test.ts`) with zero props and before any await, so the demo pays
 * nothing for a live-only read and its bytes do not move. The live branch
 * reads this workspace's keys and keeps the ones the endpoint admits (D642),
 * resolves the address the operator publishes (D653), and hands both to a
 * client component. The workspace comes from the session and from nowhere
 * else (D113).
 */
const asDay = (at: Date): string => at.toISOString().slice(0, 10);

export default async function Mcp() {
  if (dataMode !== "live") return <McpPage />;
  await connection();
  const session = await getSessionContext();
  if (!session) redirect("/login");
  const keys = await listApiKeys(session.workspaceId, queryRows);
  return (
    <McpLive
      endpoint={resolveMcpEndpoint()}
      keys={keys
        .filter((key) => (MCP_ADMITTED_SCOPES as readonly string[]).includes(key.scope))
        .map((key) => ({
          id: key.id,
          name: key.name,
          prefix: key.prefix,
          scope: key.scope,
          revoked: key.revokedAt ? asDay(key.revokedAt) : null,
        }))}
    />
  );
}
