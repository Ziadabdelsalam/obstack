import assert from "node:assert/strict";
import test from "node:test";
import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";
import { resolveIngestEndpoints } from "./ingest-endpoint";

// run with: npm test --workspace apps/web
//
// D277: this resolver moved here (from `lib/ingest-endpoint.ts`, D266's
// original home) so it can carry `import "server-only"` without tainting the
// two client-safe constants it wraps. The tests moved with it.

const HTTP_VAR = "OBSTACK_PUBLIC_OTLP_HTTP_ENDPOINT";
const GRPC_VAR = "OBSTACK_PUBLIC_OTLP_GRPC_ENDPOINT";

function resetEnv(): void {
  delete process.env[HTTP_VAR];
  delete process.env[GRPC_VAR];
}

test("no override: the constants, byte-identically (D266 mirror test)", () => {
  resetEnv();
  assert.deepEqual(resolveIngestEndpoints(), { http: OTLP_HTTP_ENDPOINT, grpc: OTLP_GRPC_ENDPOINT });
});

test("an empty override string counts as unset, same as no override at all", () => {
  resetEnv();
  process.env[HTTP_VAR] = "";
  process.env[GRPC_VAR] = "";
  assert.deepEqual(resolveIngestEndpoints(), { http: OTLP_HTTP_ENDPOINT, grpc: OTLP_GRPC_ENDPOINT });
  resetEnv();
});

// The display rule's HTTP-only case (D277): a real override on one protocol
// must never render a loopback default beside it — the other protocol comes
// back `null` ("omit"), not defaulted.
test("HTTP override alone: HTTP is the override, gRPC is null (never the loopback default)", () => {
  resetEnv();
  process.env[HTTP_VAR] = "https://ingest.example.com:4318";
  assert.deepEqual(resolveIngestEndpoints(), {
    http: "https://ingest.example.com:4318",
    grpc: null,
  });
  resetEnv();
});

test("gRPC override alone: gRPC is the override, HTTP is null", () => {
  resetEnv();
  process.env[GRPC_VAR] = "https://ingest.example.com:4317";
  assert.deepEqual(resolveIngestEndpoints(), {
    http: null,
    grpc: "https://ingest.example.com:4317",
  });
  resetEnv();
});

// The display rule's "both" case: both overrides, both render.
test("both overridden: both come back as the overrides", () => {
  resetEnv();
  process.env[HTTP_VAR] = "https://ingest.example.com:4318";
  process.env[GRPC_VAR] = "https://ingest.example.com:4317";
  assert.deepEqual(resolveIngestEndpoints(), {
    http: "https://ingest.example.com:4318",
    grpc: "https://ingest.example.com:4317",
  });
  resetEnv();
});
