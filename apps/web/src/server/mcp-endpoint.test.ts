import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { MCP_LOOPBACK_ENDPOINT, MCP_PATH } from "@/lib/mcp-types";
import { resolveMcpEndpoint } from "./mcp-endpoint";

test("D653: no override means the loopback address, and it ends in the promised path", () => {
  delete process.env.OBSTACK_PUBLIC_MCP_ENDPOINT;
  assert.equal(resolveMcpEndpoint(), MCP_LOOPBACK_ENDPOINT);
  assert.ok(MCP_LOOPBACK_ENDPOINT.endsWith(MCP_PATH), "the loopback default does not end in MCP_PATH");
});

test("D653/D277: an override is read at call time, and an empty one is unset", () => {
  process.env.OBSTACK_PUBLIC_MCP_ENDPOINT = "https://obstack.example.test/mcp";
  assert.equal(resolveMcpEndpoint(), "https://obstack.example.test/mcp");
  process.env.OBSTACK_PUBLIC_MCP_ENDPOINT = "";
  assert.equal(resolveMcpEndpoint(), MCP_LOOPBACK_ENDPOINT, "an empty override must read as unset, like ingest's");
  delete process.env.OBSTACK_PUBLIC_MCP_ENDPOINT;
});


test("the chart's Ingress branch renders the override at MCP_PATH (the pilot packet's 0.7.0)", () => {
  // A Helm template cannot import the constant, so its `/mcp` is a second copy
  // of `MCP_PATH` — the `mirror.test.ts` rule: a literal with a shared
  // definition is asserted equal to it here, read as text.
  const template = readFileSync(
    path.resolve(import.meta.dirname, "../../../../deploy/helm/obstack/templates/web/deployment.yaml"),
    "utf8",
  );
  const rendered = template.match(
    /name: OBSTACK_PUBLIC_MCP_ENDPOINT\n\s+value: \{\{ printf "%s:\/\/%s([^"]*)"/,
  );
  assert.ok(rendered, "templates/web/deployment.yaml no longer renders OBSTACK_PUBLIC_MCP_ENDPOINT from a printf");
  assert.equal(rendered[1], MCP_PATH, "the chart's MCP address suffix and MCP_PATH disagree");
});
