import assert from "node:assert/strict";
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
