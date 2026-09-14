import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_LABELS,
  DEFAULT_API_KEY_SCOPE,
  MCP_ADMITTED_SCOPES,
} from "./mcp-types";

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, "../../../..");
const DDL = readFileSync(
  path.join(REPO_ROOT, "services/ingest/pgmigrations/0014_api_key_scope.sql"),
  "utf8",
);

test("D366: mcp-types.ts carries no imports and is never server-only", () => {
  // The `incident-types.test.ts` pin verbatim: it is what makes this module a
  // legal import for the settings picker, a `"use client"` component.
  const source = readFileSync(path.join(HERE, "mcp-types.ts"), "utf8");
  assert.equal(/^import /m.test(source), false, "mcp-types.ts must carry no imports");
  assert.ok(!/^import ["']server-only["'];?$/m.test(source), "mcp-types.ts must never be server-only");
});

test("D644: the scope vocabulary is 0014's CHECK clause, parsed, not restated", () => {
  // The `landing-fence.test.ts` idiom: a regex over the migration's own bytes.
  const check = /CHECK \(scope IN \(([^)]+)\)\)/.exec(DDL);
  assert.ok(check, "0014_api_key_scope.sql no longer carries a `CHECK (scope IN (...))` clause in the shape this test reads");
  const members = check[1].split(",").map((m) => m.trim().replace(/^'|'$/g, ""));
  assert.deepEqual(members, [...API_KEY_SCOPES], "the DDL's scope members and API_KEY_SCOPES disagree");

  const dflt = /DEFAULT '(\w+)'/.exec(DDL);
  assert.ok(dflt, "0014_api_key_scope.sql no longer states a DEFAULT for scope");
  assert.equal(dflt[1], DEFAULT_API_KEY_SCOPE, "the column's DEFAULT and DEFAULT_API_KEY_SCOPE disagree");

  assert.match(DDL, /ADD COLUMN IF NOT EXISTS scope/, "the ALTER lost its guard — the double-apply would fail");
  assert.match(DDL, /CONSTRAINT api_keys_scope_check/, "the CHECK lost its name — a later widening has nothing to DROP");
});

test("D642: the endpoint admits read and setup, never ingest, and every scope has one label", () => {
  for (const scope of MCP_ADMITTED_SCOPES) {
    assert.ok(API_KEY_SCOPES.includes(scope), `${scope} is admitted at /mcp but is not a scope`);
  }
  assert.equal((MCP_ADMITTED_SCOPES as readonly string[]).includes("ingest"), false, "an ingest key must not open the MCP door");
  assert.deepEqual([...MCP_ADMITTED_SCOPES], ["read", "setup"]);
  assert.deepEqual(Object.keys(API_KEY_SCOPE_LABELS).sort(), [...API_KEY_SCOPES].sort());
  for (const scope of API_KEY_SCOPES) {
    assert.ok(API_KEY_SCOPE_LABELS[scope].startsWith(`${scope} — `), `the ${scope} label does not lead with its own name`);
  }
});
