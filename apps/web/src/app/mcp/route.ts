import { resolveApiKey } from "@/server/api-keys";
import { forWorkspace } from "@/server/clickhouse";
import { dataForWorkspace, dataMode, referenceNowMs } from "@/server/data";
import { mcpRequestHandler } from "@/server/mcp/handler";
import { queryRows } from "@/server/postgres";

/**
 * `/mcp` (S8.1 D640): OUTSIDE the `/app` shell — Next forbids a `route.ts`
 * beside a `page.tsx` at one segment, and the shell's gate is a redirect to
 * `/login`, which is the wrong answer for a JSON-RPC client (it wants a 401 in
 * its own vocabulary). The whole handler lives in `server/mcp/handler.ts`,
 * built here from the real resolver and the real scoped readers; every method
 * routes to the same function so the SDK answers the method matrix.
 */
const handle = mcpRequestHandler({
  mode: dataMode,
  resolve: (token) => resolveApiKey(token, queryRows),
  contextFor: (key) => ({
    workspaceId: key.workspaceId,
    keyId: key.keyId,
    scope: key.scope,
    data: dataForWorkspace(key.workspaceId),
    ch: forWorkspace(key.workspaceId),
    query: queryRows,
    nowMs: referenceNowMs(),
  }),
});

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
