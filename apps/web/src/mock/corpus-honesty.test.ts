import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
const mcpSource = read("mcp.ts");

/**
 * The fold, once (S4.4 R3 finding 2). These bans read `source.includes(needle)`
 * until R3, and a host or a person's name is the same host or person in any
 * casing — `Charts.Obstack.dev` in a heading, `ZIAD ABDELSALAM` in a seeded
 * label. A case-sensitive ban on a literal somebody would retype is a ban on
 * one spelling of it, which is the R1 finding `TourGuide.test.ts` already
 * carried and the shape the landing fence's registry now folds in one place.
 */
const says = (source: string, phrase: string) => source.toLowerCase().includes(phrase.toLowerCase());

/**
 * THE DOCS ARE NO LONGER MOCK (S4.4 T1). `src/mock/docs.ts` — ten invented
 * Loopwork articles — is deleted; the real corpus is MDX under
 * `src/content/**`, rendered by one component onto `/docs` and `/app/docs`
 * (D319/D320). The two assertions below were written against the fiction and
 * now read the documentation a stranger is actually told to follow, which is
 * the stricter target: a fabricated host in a demo article was a story, and
 * the same host in the published quickstart is a command that fails.
 *
 * Read as text, every file in the tree — `.mdx` pages, the conventions
 * `README.md`, the manifest. The suite runs under
 * `tsx --conditions react-server` and has no MDX loader, and text is the right
 * grain anyway: what is banned here is a LITERAL a reader would copy.
 */
const CONTENT_ROOT = path.join(import.meta.dirname, "../content");
function readCorpus(dir: string): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readCorpus(full));
    else if (/\.(mdx|md|ts|tsx)$/.test(entry.name)) {
      out.push({ file: path.relative(CONTENT_ROOT, full), source: readFileSync(full, "utf8") });
    }
  }
  return out;
}
const contentCorpus = readCorpus(CONTENT_ROOT);
const contentText = contentCorpus.map((f) => f.source).join("\n");
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
  const sources: Record<string, string> = { "mcp.ts": mcpSource, "McpPage.tsx": pageSource };
  // Every file of the real corpus, named individually so a failure says which
  // page carries the lie rather than "somewhere in the docs".
  for (const { file, source } of contentCorpus) sources[`content/${file}`] = source;
  assert.ok(contentCorpus.length > 0, "the docs corpus is empty — this test would pass by having nothing to read");
  for (const lie of [
    "charts.obstack.dev",
    "mcp.obstack.dev",
    "cf.obstack.dev",
    "obstack/collector:latest",
    "ob_mcp_read_",
  ]) {
    for (const [name, source] of Object.entries(sources)) {
      assert.equal(says(source, lie), false, `${lie} is back in ${name}`);
    }
  }
});

// The mock corpus's version of this test read a runbook that invented a
// cluster. The published docs invent nothing: a `helm install` line here is an
// instruction a reader runs, so the chart it names must be a chart in this
// repo — the same rule, against a target where breaking it costs somebody an
// afternoon.
//
// WHY THE BRANCH. The old assertion failed closed on an empty corpus
// (`charts.length >= 1`), which is the property worth keeping: a test that
// checks every helm command passes trivially when there are none. T1 built the
// mechanism and T2 writes the self-hosting page, so between them the corpus
// has zero helm lines and no honest strict assertion to make — a placeholder
// page carrying a fake `helm install` to keep this green would be exactly the
// fiction this file exists to delete. So the fail-closed property moves to a
// MARKER: with no helm command in the tree, T2's obligation must be present
// and visible in `src/content/docs/README.md`. It cannot pass vacuously by
// accident, only by a deliberate edit to two files. When T2 writes the real
// command the strict branch takes over on its own and the marker line goes.
const HELM_PENDING_MARKER = "<!-- T2: helm command pending -->";

test("every helm command in the docs installs a chart that exists in-repo", () => {
  const charts = [...contentText.matchAll(/helm install \S+ ([A-Za-z0-9._/-]+)/g)].map((m) => m[1]);
  if (charts.length === 0) {
    assert.ok(
      contentText.includes(HELM_PENDING_MARKER),
      "the docs have no helm command and no pending marker — this assertion has nothing to check and must not pass quietly",
    );
    return;
  }
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
      assert.equal(says(source, identity), false, `${name} casts ${identity} again`);
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
