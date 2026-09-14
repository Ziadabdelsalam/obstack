import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { MCP_SETUP_TARGETS, MCP_TOOL_NAMES } from "@/lib/mcp-types";
import { KEY_NAME_MAX } from "@/server/api-keys";
import { NOT_YET_SERVED, TOOL_DEFINITIONS, noSuch } from "./tools";

const HERE = import.meta.dirname;

test("D649: the handler map is total over the registry, every face is an object schema, and nothing is left unserved (T4)", () => {
  for (const name of MCP_TOOL_NAMES) {
    const def = TOOL_DEFINITIONS[name];
    assert.equal(def.name, name, `${name}'s definition names ${def.name}`);
    assert.equal(typeof def.handler, "function");
    assert.equal(def.inputSchema instanceof z.ZodObject, true, `${name}: the face is not an object schema`);
  }
  // T3 pinned fourteen names here; T4 drives the set to nothing, and this is
  // the assertion that says so — a `notYet()` that ever returns goes red.
  assert.deepEqual([...NOT_YET_SERVED], []);
});

test("D648: the faces mirror their contracts — defaults, bounds and the required metric type", () => {
  const face = (name: (typeof MCP_TOOL_NAMES)[number]) => TOOL_DEFINITIONS[name].inputSchema;
  assert.equal(face("get_trace").safeParse({ id: "" }).success, false);
  assert.equal(face("get_trace").safeParse({}).success, false);
  assert.equal(face("get_trace").safeParse({ id: "a3f8c1d92b6e407f" }).success, true);

  assert.equal(face("query_traces").safeParse({}).success, true, "every trace filter field is optional, as the contract's are");
  assert.equal(face("query_traces").safeParse({ status: "slow" }).success, false);
  assert.equal(face("query_traces").safeParse({ rangeMs: 31 * 24 * 3600 * 1000 }).success, false, "a window past the longest retention");
  assert.equal(face("search_logs").safeParse({ minSeverity: "error" }).success, true);
  assert.equal(face("search_logs").safeParse({ minSeverity: "error+" }).success, false, "the mock's severity DSL is not the contract's");

  const series = face("get_metric_series").safeParse({ metric: "m", type: "gauge", range: "1h", agg: "avg" });
  assert.equal(series.success, true);
  assert.deepEqual((series.data as { groupBy: unknown; filters: unknown }).groupBy, null, "groupBy defaults to null");
  assert.deepEqual((series.data as { groupBy: unknown; filters: unknown }).filters, {}, "filters default to {}");
  assert.equal(face("get_metric_series").safeParse({ metric: "m", range: "1h", agg: "avg" }).success, false, "type is REQUIRED (D384)");

  const alerts = face("list_alerts").safeParse({});
  assert.equal((alerts.data as { eventLimit: number }).eventLimit, 50);
  assert.equal(face("list_alerts").safeParse({ eventLimit: 201 }).success, false);
  assert.equal(face("list_changes").safeParse({ limit: 0 }).success, false);

  assert.equal(face("issue_ingest_key").safeParse({ name: "x".repeat(KEY_NAME_MAX - 4) }).success, true);
  assert.equal(face("issue_ingest_key").safeParse({ name: "x".repeat(KEY_NAME_MAX - 3) }).success, false, "the mcp: prefix must fit inside the name bound");
  assert.equal(face("get_setup_recipe").safeParse({ target: MCP_SETUP_TARGETS[0] }).success, true);
  assert.equal(face("check_arrival").safeParse({}).success, true);
});

test("D650: the miss sentence is the NO_SUCH_* shape", () => {
  assert.equal(noSuch("trace"), "no trace with this id in your workspace");
  assert.equal(noSuch("incident"), "no incident with this id in your workspace");
});

test("D646: nothing under server/mcp/ can reach the Explain rail", () => {
  // The spend is the one thing an agent must not be able to loop (D646): the
  // grep is the guard, over every file in this directory, tests included.
  for (const file of readdirSync(HERE)) {
    if (!/\.tsx?$/.test(file)) continue;
    const source = readFileSync(path.join(HERE, file), "utf8");
    for (const needle of ["spendExplainRun", "getExplain(", "explain/quota", "server/explain"]) {
      const mentions = source.split(needle).length - 1;
      // This test names the needles once each, in the array above — every
      // other occurrence is a reach.
      const allowed = file === "tools.test.ts" ? 1 : 0;
      assert.equal(mentions, allowed, `${file} reaches the Explain rail via ${needle}`);
    }
  }
});
