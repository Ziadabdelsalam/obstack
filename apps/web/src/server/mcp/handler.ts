import "server-only";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { MCP_RATE_LIMIT } from "@/lib/mcp-types";
import type { ResolvedApiKey } from "@/server/api-keys";
import type { DataMode } from "@/server/data";
import type { McpContext } from "@/server/mcp/context";
import { createMcpServer } from "@/server/mcp/server";
import { checkRateLimit } from "@/server/rate-limit";

/**
 * The `/mcp` request handler (S8.1 D640–D645), built from its dependencies so
 * `handler.test.ts` can drive it with a stock protocol client and no store:
 * `app/mcp/route.ts` wires the real resolver and context builder.
 *
 * The order, and why each line sits where it does:
 *
 *   1. mock guard — 404 with the tripwire line (D651): the demo host serves no
 *      tools, and a request here came from somewhere no visitor can be.
 *   2. the bearer — `resolveApiKey`'s answer, or a bodiless 401 with the
 *      challenge header; unknown, revoked, ingest-scoped and malformed are ONE
 *      answer (D6/D642). Before the rate limit, so an unauthenticated flood is
 *      bounded by the 401's cost and never counted against anyone's key.
 *   3. the per-key window (D645) — 429 with Retry-After, before the transport,
 *      so an over-limit call is an HTTP answer and never a tool result.
 *   4. GET — the optional server-to-client notification stream — is refused
 *      HERE with 405 (D672): the spec lets a server decline that stream, and
 *      on a per-request server the SDK's alternative is a 200 SSE body that
 *      would hold an idle server instance open for every client that asks.
 *      Nothing is lost — this server sends no notifications — and a stock
 *      client treats the 405 as "no stream" and carries on.
 *   5. one server + one stateless JSON transport per request (D641): no
 *      session id issued, none validated, nothing to sweep; everything else in
 *      the method matrix (DELETE with no session, a missing Accept) is the
 *      SDK's answer, never ours to restate.
 */
export interface McpHandlerDeps {
  mode: DataMode;
  resolve: (token: string) => Promise<ResolvedApiKey | null>;
  contextFor: (key: ResolvedApiKey) => McpContext;
}

/** `Authorization: Bearer <token>` — the scheme case-insensitive, exactly one token, nothing else. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}

const unauthorized = () =>
  new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="obstack"' } });

export function mcpRequestHandler(deps: McpHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    if (deps.mode === "mock") {
      console.error("[mcp] request in mock mode — this deployment serves no tools");
      return new Response(null, { status: 404 });
    }
    const token = bearerToken(request.headers.get("authorization"));
    const key = token ? await deps.resolve(token) : null;
    if (!key) return unauthorized();
    if (request.method === "GET") {
      return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
    }
    if (!checkRateLimit("mcp", key.keyId)) {
      return new Response(null, {
        status: 429,
        headers: { "retry-after": String(Math.ceil(MCP_RATE_LIMIT.windowMs / 1000)) },
      });
    }
    const server = createMcpServer(deps.contextFor(key));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(request);
  };
}
