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

// ------------------------------------------------------------ T2: the registry

import { readFileSync as readSource } from "node:fs";
import { mcpTools as mockTools } from "@/mock/mcp";
import { isLiveWiredRoute } from "@/lib/live-routes";
import { snippetsFor } from "@/components/onboarding/snippets";
import { connectors } from "@/components/connections/connectors";
import {
  MCP_PROMPTS,
  MCP_RATE_LIMIT,
  MCP_SERVER_VERSION,
  MCP_SETUP_TARGETS,
  MCP_TOOLS,
  MCP_TOOL_NAMES,
} from "./mcp-types";

const mockNames = mockTools.map((t) => t.name);

test("D647: get_pipeline_runs stays out of the registry while /app/pipelines is unwired", () => {
  // Registry-coupled, the `mirror.test.ts` §7.7 idiom: when pipelines wires,
  // this premise flips and the tool is owed — the assertion says so.
  assert.equal(isLiveWiredRoute("/app/pipelines"), false, "premise: /app/pipelines is unwired — when it wires, get_pipeline_runs is owed and this test moves");
  assert.equal((MCP_TOOL_NAMES as readonly string[]).includes("get_pipeline_runs"), false, "the registry serves a tool over a mock surface");
  assert.ok(mockNames.includes("get_pipeline_runs"), "the mock stopped promising get_pipeline_runs — D647's coupling has nothing to guard");
});

test("D647/D648: the seven names shared with the mock are spelled identically; get_metrics is the two honest halves", () => {
  const shared = MCP_TOOL_NAMES.filter((n) => (mockNames as string[]).includes(n)).sort();
  assert.deepEqual(shared, [
    "get_incident",
    "get_service_map",
    "get_slo_status",
    "get_trace",
    "list_issues",
    "query_traces",
    "search_logs",
  ]);
  // A near-miss (a live name that is a mock name re-cased or re-separated) is
  // a second spelling of one thing — caught by normalising both sides.
  const norm = (n: string) => n.toLowerCase().replace(/[^a-z]/g, "");
  for (const name of MCP_TOOL_NAMES) {
    const twin = mockNames.find((m) => norm(m) === norm(name) && m !== name);
    assert.equal(twin, undefined, `${name} is ${twin} spelled differently`);
  }
  assert.equal((MCP_TOOL_NAMES as readonly string[]).includes("get_metrics"), false, "the mock's get_metrics shape is a contract this product never froze (D648)");
  assert.ok(MCP_TOOL_NAMES.includes("list_metrics") && MCP_TOOL_NAMES.includes("get_metric_series"));
  assert.equal(MCP_TOOL_NAMES.length, 15, "twelve reads plus three setup tools (D648, D665–D667)");
  assert.equal(new Set(MCP_TOOL_NAMES).size, MCP_TOOL_NAMES.length, "a tool name is registered twice");
});

test("D646/D649: every spec has prose, an example that names it, a kind, and no capability the tree lacks", () => {
  for (const spec of MCP_TOOLS) {
    assert.ok(spec.description.length > 20, `${spec.name}: no description`);
    assert.ok(spec.example.startsWith(`${spec.name}(`), `${spec.name}: the example calls something else`);
    assert.ok(spec.kind === "read" || spec.kind === "setup");
    assert.doesNotMatch(spec.description, /root[ -]?cause|\bRCA\b|pipeline/i, `${spec.name} promises what the tree does not serve (D646/D647)`);
  }
  assert.deepEqual(
    MCP_TOOLS.filter((t) => t.kind === "setup").map((t) => t.name),
    ["get_setup_recipe", "issue_ingest_key", "check_arrival"],
  );
});

test("D665: every setup target is a quickstart tab or an available connector with steps — no target this product cannot serve", () => {
  const tabs = snippetsFor("<OBSTACK_API_KEY>", { http: "http://127.0.0.1:4318", grpc: null }).map((t) => t.id);
  const withSteps = connectors
    .filter((c) => c.status === "available" && (c.connectSteps?.length ?? 0) > 0)
    .map((c) => c.slug);
  assert.deepEqual([...MCP_SETUP_TARGETS], [...tabs, ...withSteps], "MCP_SETUP_TARGETS is not the tabs followed by the connectors that ship steps");
});

test("D668: the one prompt names every tool it tells the agent to call, and no tool it does not", () => {
  assert.equal(MCP_PROMPTS.length, 1);
  const [setup] = MCP_PROMPTS;
  assert.equal(setup.name, "setup");
  assert.equal(setup.steps.length, 6, "the packet's six steps");
  const named = new Set<string>();
  for (const step of setup.steps) {
    for (const m of step.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) named.add(m[1]);
  }
  for (const n of named) assert.ok((MCP_TOOL_NAMES as readonly string[]).includes(n), `the prompt tells the agent to call \`${n}\`, which is not a tool`);
  assert.deepEqual([...named].sort(), ["check_arrival", "get_setup_recipe", "get_trace", "issue_ingest_key"]);
  for (const target of MCP_SETUP_TARGETS) assert.ok(setup.steps[0].includes(`\`${target}\``), `step 1 does not offer the ${target} target`);
  assert.ok(setup.steps[2].includes("Never commit the key"), "the prompt lost the one line about secrets");
});

test("the server's version is the web package's, and the rate limit is a real bound", () => {
  const pkg = JSON.parse(readSource(path.join(HERE, "../../package.json"), "utf8")) as { version: string };
  assert.equal(MCP_SERVER_VERSION, pkg.version);
  assert.ok(MCP_RATE_LIMIT.max > 0 && MCP_RATE_LIMIT.windowMs > 0);
});
