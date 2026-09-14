import assert from "node:assert/strict";
import { createHash, } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const HERE = import.meta.dirname;
const read = (rel: string) => readFileSync(path.join(HERE, rel), "utf8");
const sha = (source: string) => createHash("sha256").update(source).digest("hex");

/**
 * S8.1 T5 (D652): the flip's two bodies. The mock body is the S3.4 page and
 * its data, byte for byte — pinned to the commit the flip was cut from
 * (`02bf550`, the S7.4 close merge): to regenerate a pin, `git show
 * 02bf550:apps/web/src/components/mcp/McpPage.tsx | shasum -a 256`, never
 * `master`, which moves.
 */
test("D652: McpPage.tsx and mock/mcp.ts are the pre-flip bytes — the demo's fiction is frozen", () => {
  assert.equal(sha(read("../../../components/mcp/McpPage.tsx")), "4a761c90b2ba15d8c459c61e1ae2cbcf33dcbfe50da21db2482a727365f5b4f3");
  assert.equal(sha(read("../../../mock/mcp.ts")), "9f8d3adfd6c6cd535e3d381de2d2715a1d500e59e9ff536bd100fecafc285272");
});

test("D652: the page branches on the mode before any await, and the live body is its own component", () => {
  const page = read("page.tsx");
  const branch = page.indexOf('if (dataMode !== "live") return <McpPage />;');
  const firstAwait = page.indexOf("await ");
  assert.ok(branch >= 0, "the mock branch is gone");
  assert.ok(firstAwait > branch, "an await runs before the mock branch — mock mode would pay for a live read");
  assert.ok(page.includes("<McpLive"), "the live branch does not render McpLive");
  assert.ok(page.includes("resolveMcpEndpoint()"), "the live page does not resolve the operator's address (D653)");
  assert.ok(page.includes("MCP_ADMITTED_SCOPES"), "the live page lists keys the endpoint would refuse");
});

test("D654/D655: McpLive prints no token, keeps the tour anchor, and names what is not kept", () => {
  const live = read("../../../components/mcp/McpLive.tsx");
  assert.ok(live.startsWith('"use client"'));
  assert.ok(live.includes('data-tour="mcp"'), "the tour's anchor is missing from the live body (D523's rule)");
  assert.ok(live.includes("MCP_API_KEY_PLACEHOLDER"), "the header line must carry the placeholder, never a token");
  // The RENDERED strings, not the comments that explain them: strip the JSDoc
  // and line comments, then require that no token shape and no literal key
  // ever reaches the markup.
  const rendered = live.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/ok_live_[0-9a-f]{4,}/.test(rendered), false, "a token shape is in the live markup (D98)");
  assert.equal(/\btoken\b/.test(rendered), false, "the live markup speaks of a token — it prints none (D98)");
  assert.ok(live.includes("MCP_NO_CALL_LOG_SENTENCE"), "the D655 sentence is not on the page");
  assert.ok(!live.includes("@/mock/"), "the live body imports the demo's fiction");
  assert.ok(live.includes("MCP_TOOLS"), "the tools section does not read THE registry");
});
