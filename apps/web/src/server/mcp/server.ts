import "server-only";
import { McpServer } from "@modelcontextprotocol/server";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION, MCP_TOOLS } from "@/lib/mcp-types";
import type { McpContext } from "@/server/mcp/context";
import { TOOL_DEFINITIONS } from "@/server/mcp/tools";

/**
 * One `McpServer` per request (S8.1 D641), registered from THE registry
 * (`MCP_TOOLS`, D647/D649) in one loop: the name, the description and the
 * example are the registry's, the zod face and the handler are
 * `TOOL_DEFINITIONS`'s, and the annotations say what every tool is — read-only
 * and idempotent, except the one mint (D666), which is neither read-only nor
 * idempotent and is still not destructive. The context is closed over here and
 * never reaches the SDK's own `ctx`, so a handler cannot be handed another
 * workspace by any message on the wire (D643).
 */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  for (const spec of MCP_TOOLS) {
    const definition = TOOL_DEFINITIONS[spec.name];
    const mutates = spec.name === "issue_ingest_key";
    server.registerTool(
      spec.name,
      {
        description: `${spec.description}. Example: ${spec.example}`,
        inputSchema: definition.inputSchema,
        annotations: {
          readOnlyHint: !mutates,
          destructiveHint: false,
          idempotentHint: !mutates,
          openWorldHint: false,
        },
      },
      async (args: unknown) => definition.handler(args, ctx),
    );
  }
  return server;
}
