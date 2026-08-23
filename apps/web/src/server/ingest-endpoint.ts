import "server-only";
import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";

/**
 * The M4 self-hosted escape hatch (D266), split out of `lib/ingest-endpoint.ts`
 * (D277) so it can carry `import "server-only"` without poisoning that file's
 * client-safe constants for the two `"use client"` surfaces that import them
 * directly (`Quickstart.tsx`, `DemoArrival.tsx`) — importing a `server-only`
 * module from client code is a build-time error, not a runtime one, so the two
 * halves cannot share a file.
 *
 * `OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT` / `OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT`
 * ("PUBLIC" = what we tell operators, distinct from the collector's internal
 * `OBSTACK_INGEST_ENDPOINT`), never `NEXT_PUBLIC_`-prefixed and never read at
 * build time: that prefix bakes the value into the client bundle at `next
 * build`, and one image serving many deployments cannot bake in a
 * per-deployment address (`node_modules/next/dist/docs/01-app/02-guides/
 * environment-variables.md`, "Bundling Environment Variables for the
 * Browser"). Call this only from a dynamically-rendered server path — after
 * `await connection()` or another request-time API — so the read happens at
 * request time rather than being folded into a statically-rendered page at
 * build time (same doc, "Runtime Environment Variables": "You can safely read
 * environment variables on the server during dynamic rendering"). Its result
 * is passed down to client children as props; it is never imported by one.
 *
 * The display rule (D277): an operator with no override sees the same two
 * loopback defaults every checkout has always shown — byte-identical to the
 * constants. An operator with an override, even a partial one, sees ONLY the
 * protocol(s) they actually configured: a `null` here means "omit this
 * protocol from the render," never "fall back to the loopback default," so
 * the quickstart never shows a default address beside a real one — a
 * self-hosted deployment's exporter next to a loopback address nothing on
 * that deployment is listening on would be the display-side version of the
 * S2.2 L1 lie the old quickstart carried.
 */
export function resolveIngestEndpoints(): { http: string | null; grpc: string | null } {
  // `||`, not `??`: an empty value is unset (an operator who exported the name
  // with no address configured nothing).
  const http = process.env.OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT || null;
  const grpc = process.env.OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT || null;
  if (!http && !grpc) return { http: OTLP_HTTP_ENDPOINT, grpc: OTLP_GRPC_ENDPOINT };
  return { http, grpc };
}
