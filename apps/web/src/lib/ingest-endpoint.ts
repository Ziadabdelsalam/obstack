/**
 * Where this deployment's OTLP actually listens — the ONE definition every
 * surface that tells an operator where to export reads (D215).
 *
 * These are compose's published ingest ports, mirrored from
 * `deploy/compose/docker-compose.yml:101-102`:
 *
 *     - "127.0.0.1:4317:4317" # OTLP/gRPC
 *     - "127.0.0.1:4318:4318" # OTLP/HTTP
 *
 * `ingest-endpoint.test.ts` re-reads that file and fails if the two ever
 * disagree — the mirror pattern the drive's `FLUSH_MS` uses for the Go
 * constants (D206), because a comment naming a source is not a check.
 *
 * There is deliberately NO environment variable behind these two constants.
 * `OBSTACK_INGEST_ENDPOINT` is already taken in the same compose file (`:249`)
 * for the collector's UPSTREAM address (`http://ingest:4318`, a name that only
 * resolves inside the compose network), so a shell exporting it for collector
 * work would have repointed the quickstart at an address the operator's
 * browser and host cannot reach.
 *
 * No `server-only`: this is client-safe by construction — two string
 * literals, no env read, no secret — which is why the existing `"use client"`
 * snippet surfaces (`Quickstart.tsx`, `DemoArrival.tsx`) import them directly.
 * A deployment that wants to override either one reads `resolveIngestEndpoints`
 * at `@/server/ingest-endpoint` instead (D266/D277) — that module carries
 * `import "server-only"`, which this one deliberately cannot.
 */

/** OTLP over HTTP/protobuf — what the SDKs and the e2e drive send to. */
export const OTLP_HTTP_ENDPOINT = "http://127.0.0.1:4318";

/** OTLP over gRPC — the same ingest, the other standard port. */
export const OTLP_GRPC_ENDPOINT = "http://127.0.0.1:4317";
