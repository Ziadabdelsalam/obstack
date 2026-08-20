import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { MCP_ENDPOINT_PLACEHOLDER, MCP_TOKEN_PLACEHOLDER, mcpSetup } from "./mcp";

/**
 * The `connectors.test.ts` lie list, extended to the rest of the corpus a
 * reader can act on (S3.5 honesty pass). The connectors catalog was swept in
 * S3.4; the demo docs, the MCP page and the two surfaces that print a key were
 * not, and they carried the same class of fiction — a host that resolves
 * nowhere, a credential spelled out in full.
 *
 * Demo content is allowed to be invented (D208): these tests are about the
 * lines a reader would copy and run, not about the story around them.
 */

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(import.meta.dirname, p), "utf8");
const docsSource = read("docs.ts");
const mcpSource = read("mcp.ts");
const pageSource = readFileSync(
  path.join(import.meta.dirname, "../components/mcp/McpPage.tsx"),
  "utf8",
);
const keyCarriers = { "workspace.ts": read("workspace.ts"), "security.ts": read("security.ts") };

/**
 * THE MIRRORED LIST (D206 pattern, ruled by D235) — the real identity two tests
 * ban and neither could see the other banning.
 *
 * `components/shell/shell-honesty.test.ts` keeps TopBar's fallback identity from
 * naming a real person; these are the same literals in the mock corpus, which
 * the shell test does not read. One shared constant is not importable: a module
 * exporting the list would itself be a corpus file carrying the literals, and a
 * test file cannot be imported without running its tests twice. So the list is
 * restated, and pinned below against the shell test's own source — drop a
 * literal there and this goes red in the same round.
 */
const BANNED_IDENTITY = ["Ziad Abdelsalam", "ziad@loopwork.ai"];
const personaCarriers = {
  "oncall.ts": read("oncall.ts"),
  "inbox.ts": read("inbox.ts"),
  "workspace.ts": keyCarriers["workspace.ts"],
};

test("no fabricated host or credential in the docs, the MCP data or the MCP page", () => {
  const sources = { "docs.ts": docsSource, "mcp.ts": mcpSource, "McpPage.tsx": pageSource };
  for (const lie of [
    "charts.obstack.dev",
    "mcp.obstack.dev",
    "cf.obstack.dev",
    "obstack/collector:latest",
    "ob_mcp_read_",
  ]) {
    for (const [name, source] of Object.entries(sources)) {
      assert.equal(source.includes(lie), false, `${lie} is back in ${name}`);
    }
  }
});

test("every helm command in the runbooks installs a chart that exists in-repo", () => {
  // Only the helm lines are checked against this repo: a runbook's `kubectl
  // -n prod set image deploy/gateway` names a Deployment in the demo company's
  // cluster, which is story, not an artifact anyone can resolve here.
  const charts = [...docsSource.matchAll(/helm install \S+ ([A-Za-z0-9._/-]+)/g)].map((m) => m[1]);
  assert.ok(charts.length >= 1, "expected a runbook to install the chart");
  for (const c of charts) {
    assert.ok(existsSync(path.join(repoRoot, c)), `${c} is not a chart in this repo`);
    assert.equal(c.startsWith("deploy/helm/"), true, `${c} is not the in-repo chart path`);
  }
});

test("every MCP snippet carries the placeholders, never a host or a token", () => {
  // The `<…>` form says "you supply this" the way the connectors catalog's
  // API_KEY_PLACEHOLDER does — and nothing is servable, so there is no value
  // to supply yet either.
  assert.match(MCP_ENDPOINT_PLACEHOLDER, /^<[A-Z_]+>\/mcp$/);
  assert.match(MCP_TOKEN_PLACEHOLDER, /^<[A-Z_]+>$/);
  assert.equal(mcpSetup.length, 3);
  for (const s of mcpSetup) {
    assert.ok(s.snippet.includes(MCP_ENDPOINT_PLACEHOLDER), `${s.id}: no endpoint placeholder`);
    assert.ok(s.snippet.includes(MCP_TOKEN_PLACEHOLDER), `${s.id}: no token placeholder`);
    assert.equal(/https?:\/\//.test(s.snippet), false, `${s.id}: names a URL of its own`);
  }
  // The page renders those two and offers no clipboard button for either: a
  // copy affordance beside a credential claims the credential is yours.
  assert.ok(pageSource.includes("MCP_ENDPOINT_PLACEHOLDER"));
  assert.ok(pageSource.includes("MCP_TOKEN_PLACEHOLDER"));
  assert.equal(pageSource.includes("clipboard"), false, "the MCP page copies something again");
});

test("D235: no real person is cast in the demo corpus", () => {
  // The on-call rotation and the audit log named a real person — the maintainer
  // — beside an address of his, on a demo anyone can open. Demo content may be
  // invented (D208); it may not be borrowed from someone who did not consent.
  for (const identity of BANNED_IDENTITY) {
    for (const [name, source] of Object.entries(personaCarriers)) {
      assert.equal(source.includes(identity), false, `${name} casts ${identity} again`);
    }
  }
  // The audit log's addresses are documentation-reserved too: RFC 5737's
  // 203.0.113.0/24, never a range that routes to somebody's house.
  for (const ip of personaCarriers["inbox.ts"].match(/\bip: "(\d+\.\d+\.\d+\.\d+)"/g) ?? []) {
    assert.match(ip, /"203\.0\.113\.\d+"/, `inbox.ts logs ${ip} — an address outside the documentation range`);
  }
});

test("D235: the shell test bans the same identity, character for character", () => {
  const shell = readFileSync(
    path.join(import.meta.dirname, "../components/shell/shell-honesty.test.ts"),
    "utf8",
  );
  for (const identity of BANNED_IDENTITY) {
    assert.ok(
      shell.includes(`"${identity}"`),
      `shell-honesty.test.ts no longer bans "${identity}" — the two lists have drifted`,
    );
  }
});

test("a mock API key is always the masked prefix, never a usable key", () => {
  // Real keys are `ok_live_` + 64 hex (keystore/store.go); the product stores
  // and shows twelve characters (D144). A mock that printed more would be
  // printing a credential.
  for (const [name, source] of Object.entries(keyCarriers)) {
    // `ok_live_` with nothing after it is the docblock naming the format.
    const shown = source.match(/ok_live_[0-9a-f]+.?/g) ?? [];
    assert.ok(shown.length >= 1, `${name}: expected the masked demo key`);
    for (const k of shown) {
      assert.match(k, /^ok_live_[0-9a-f]{1,8}…$/, `${name}: an unmasked key literal: ${k}`);
    }
  }
});
