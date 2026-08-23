import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "./ingest-endpoint";

// The pinned mirror (D215, the FLUSH_MS/D206 pattern): these constants restate
// what compose publishes, and a restatement nobody checks is a comment. Change
// the published ports and this goes red in the same run.

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const composeFile = readFileSync(path.join(repoRoot, "deploy/compose/docker-compose.yml"), "utf8");

test("the constants are the ports compose publishes", () => {
  assert.equal(OTLP_HTTP_ENDPOINT, "http://127.0.0.1:4318");
  assert.equal(OTLP_GRPC_ENDPOINT, "http://127.0.0.1:4317");
  for (const endpoint of [OTLP_HTTP_ENDPOINT, OTLP_GRPC_ENDPOINT]) {
    const hostPort = endpoint.replace("http://", "");
    const port = hostPort.split(":")[1];
    assert.ok(
      composeFile.includes(`"${hostPort}:${port}"`),
      `compose no longer publishes ${hostPort} — the quickstart would name a closed port`,
    );
  }
});

test("nothing hosted and nothing from the environment", () => {
  // U1: there is no hosted obstack, so a hosted name here is the S2.2 L1 lie the
  // old quickstart carried. And no env read at all — the resolver that reads
  // the environment moved to `@/server/ingest-endpoint` (D277); this module is
  // client-safe constants only.
  const source = readFileSync(path.join(import.meta.dirname, "ingest-endpoint.ts"), "utf8");
  for (const endpoint of [OTLP_HTTP_ENDPOINT, OTLP_GRPC_ENDPOINT]) {
    assert.equal(endpoint.includes("obstack.dev"), false);
  }
  assert.equal(/process\.env/.test(source), false, "this module must not read the environment");
});
