import "server-only";
import { MCP_LOOPBACK_ENDPOINT } from "@/lib/mcp-types";

/**
 * The address `/app/mcp` prints and the setup snippets carry (S8.1 D653) —
 * `ingest-endpoint.ts`'s D277 shape, verbatim in its rules:
 *
 *  - `OBSTACK_PUBLIC_MCP_ENDPOINT` is what we tell operators, never
 *    `NEXT_PUBLIC_`-prefixed and never read at build time (that prefix bakes
 *    the value into the client bundle at `next build`, and one image serving
 *    many deployments cannot bake in a per-deployment address). Call this only
 *    from a dynamically-rendered server path — after `await connection()` —
 *    and pass the result down as a prop; no client module imports it.
 *  - `||`, not `??`: an empty value is unset (an operator who exported the
 *    name with no address configured nothing).
 *  - No override means the loopback default, which is the TRUE address under
 *    `next dev`, the compose stack and a `kubectl port-forward` — the paths
 *    the drive and every local run take. The chart's Ingress branch renders the
 *    override from `web.ingress.host` (the pilot packet's 0.7.0), so a
 *    self-hosted install behind a hostname prints that hostname.
 */
export function resolveMcpEndpoint(): string {
  return process.env.OBSTACK_PUBLIC_MCP_ENDPOINT || MCP_LOOPBACK_ENDPOINT;
}
