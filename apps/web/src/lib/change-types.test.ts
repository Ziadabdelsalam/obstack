import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHANGE_KINDS, GITHUB_ACTIONS_DEPLOY_STEP } from "./change-types";

// run with: cd apps/web && npx tsx --conditions react-server --test src/lib/change-types.test.ts
//
// D499: the change-event contract exists in three places — the Go validator
// that writes the rows, this module's types, and the docs field table a
// reader copies from — and this file is the ONE test that pins them to each
// other. The D385 precedent (series-cap.parity.test.ts, alert-types.test.ts):
// read each side's REAL declaration and compare; never restate a value here,
// which would be a fourth place to update.
//
// The path: this file is `apps/web/src/lib/`, so four levels up is the repo root.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../../..");
const DOCUMENT_GO = path.join(REPO_ROOT, "services/ingest/internal/changes/document.go");
const DOCS_PAGE = path.join(HERE, "../content/docs/connectors/github-actions/index.mdx");

const goSource = readFileSync(DOCUMENT_GO, "utf8");
const docsSource = readFileSync(DOCS_PAGE, "utf8");

/** `var name = []string{"a", "b"}` → ["a", "b"]. */
function goStringSlice(source: string, name: string): string[] {
  const match = source.match(new RegExp(`var ${name} = \\[\\]string\\{([^}]*)\\}`));
  assert.ok(match, `document.go's ${name} moved or was renamed — update this regex, do not restate the values`);
  return [...match![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/** The json tags of one Go struct, in declaration order. */
function goJSONTags(source: string, structName: string): string[] {
  const match = source.match(new RegExp(`type ${structName} struct \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(match, `document.go's ${structName} struct moved or was renamed — update this regex`);
  return [...match![1].matchAll(/json:"([^"]+)"/g)].map((m) => m[1]);
}

/** The field table under "## The document": every row's backticked first
 *  column, and the row's text, in order. */
function docsFieldTable(): { name: string; row: string }[] {
  const start = docsSource.indexOf("## The document");
  assert.ok(start >= 0, "the docs page lost its '## The document' section");
  const section = docsSource.slice(start, docsSource.indexOf("\n## ", start + 1));
  const rows = [...section.matchAll(/^\| `([^`]+)` \|(.*)$/gm)].map((m) => ({ name: m[1], row: m[2] }));
  assert.ok(rows.length >= 10, `the docs field table shrank to ${rows.length} rows`);
  return rows;
}

test("D499: the six kinds are the same six in Go, in TypeScript and in the docs", () => {
  assert.deepEqual(goStringSlice(goSource, "kinds"), [...CHANGE_KINDS], "document.go's kinds have drifted from CHANGE_KINDS");

  const kindRow = docsFieldTable().find((r) => r.name === "kind");
  assert.ok(kindRow, "the docs field table has no `kind` row");
  const documented = [...kindRow!.row.matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
  assert.deepEqual(documented, [...CHANGE_KINDS], "the docs page's kind list has drifted from CHANGE_KINDS");
});

test("D499: the docs field table names exactly the fields the Go validator decodes", () => {
  const top = goJSONTags(goSource, "document");
  const link = goJSONTags(goSource, "link").map((tag) => `link.${tag}`);
  const goFields = [...top, ...link].sort();
  const documented = docsFieldTable()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(documented, goFields, "the docs field table and document.go's json tags name different fields");
});

test("D499: the docs page's limits are the validator's", () => {
  // The DDL is the authority for lengths (D500); the validator repeats them as
  // named constants, and the docs state them as numbers a reader can see. A
  // limit changed on one side without the other is a promise the route
  // breaks.
  const limits: Record<string, string> = {};
  for (const m of goSource.matchAll(/^\s*(max\w+)\s*=\s*(\d+)$/gm)) limits[m[1]] = m[2];
  const rows = Object.fromEntries(docsFieldTable().map((r) => [r.name, r.row]));
  for (const [field, constant] of [
    ["title", "maxTitle"],
    ["detail", "maxDetail"],
    ["who", "maxWho"],
    ["service", "maxService"],
    ["ref", "maxRef"],
    ["source", "maxSource"],
    ["link.label", "maxLinkLabel"],
    ["link.href", "maxLinkHref"],
    ["external_id", "maxExternalID"],
  ]) {
    assert.ok(limits[constant], `document.go lost ${constant}`);
    assert.ok(
      rows[field]?.includes(limits[constant]),
      `the docs row for ${field} does not state ${constant} = ${limits[constant]}`,
    );
  }
});

test("D499: the recipe block is one fenced yaml step between the drive's markers", () => {
  const start = docsSource.indexOf("{/* recipe:start");
  const end = docsSource.indexOf("{/* recipe:end */}");
  assert.ok(start >= 0 && end > start, "the recipe markers the e2e drive extracts by are missing");
  const between = docsSource.slice(start, end);
  const fences = between.match(/```yaml\n([\s\S]*?)\n```/g) ?? [];
  assert.equal(fences.length, 1, "exactly one yaml fence between the markers");
  const step = fences[0];
  assert.match(step, /^\s+run: \|$/m, "the step has a `run: |` block");
  assert.match(step, /\/v1\/changes"/, "the step posts to /v1/changes");
  assert.match(step, /Authorization: Bearer \$OBSTACK_API_KEY/, "the step authenticates with the key the docs name");
  assert.match(step, /GITHUB_RUN_ATTEMPT/, "the external_id includes the run attempt (D496)");
  assert.doesNotMatch(step, /https?:\/\/[a-z]/i, "the step names no host of its own (corpus honesty)");
});

test("D366: change-types.ts stays client-safe — no imports at all", () => {
  const source = readFileSync(path.join(HERE, "change-types.ts"), "utf8");
  assert.equal(/^import /m.test(source), false, "change-types.ts must carry no imports");
  assert.ok(!/^import ["']server-only["'];?$/m.test(source), "change-types.ts must never be server-only");
});

// S8.1 D671: the MCP setup tool serves the deploy step from a constant; the
// docs page keeps its fence because the e2e drive extracts and runs THAT. Two
// copies, one pin — the D499 idiom — so an edit to either goes red.
test("D671: the docs page's fenced deploy step is GITHUB_ACTIONS_DEPLOY_STEP, byte for byte", () => {
  const start = docsSource.indexOf("```yaml\n", docsSource.indexOf("recipe:start"));
  assert.ok(start >= 0, "the docs page lost its recipe:start fence");
  const body = docsSource.slice(start + "```yaml\n".length, docsSource.indexOf("\n```", start));
  assert.equal(body, GITHUB_ACTIONS_DEPLOY_STEP);
  assert.ok(GITHUB_ACTIONS_DEPLOY_STEP.includes("/v1/changes"));
});
