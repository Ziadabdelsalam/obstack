import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VALID_AGGS } from "./metrics-types";
import {
  ALERT_OPS,
  ALERT_WINDOWS,
  METRIC_TYPES,
  TRACE_SIGNALS,
  formatAlertCondition,
  validateAlertCondition,
  type AlertCondition,
} from "./alert-types";

// run with: npm test --workspace apps/web
//
// D483: the alert condition schema exists in two languages, and this file is one
// of the two consumers of the ONE artifact that freezes them together. The
// fixture file lives beside the Go half (it is Go `testdata`, which `go test`
// resolves relative to its package directory and which `go vet`/build tooling
// already knows to ignore); this side reaches it by relative path rather than
// keeping a second copy — a copy would go stale silently, which is precisely the
// failure D483 exists to prevent.
//
// The path: this file is `apps/web/src/lib/`, so four levels up is the repo root.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/web/src/lib
const REPO_ROOT = path.resolve(HERE, "../../../..");
const FIXTURES = path.join(REPO_ROOT, "services/ingest/internal/alerting/testdata/condition-fixtures.json");
const CONDITION_GO = path.join(REPO_ROOT, "services/ingest/internal/alerting/condition.go");

interface ConditionFixture {
  name: string;
  condition: unknown;
  valid: boolean;
}

function loadFixtures(): ConditionFixture[] {
  const raw: unknown = JSON.parse(readFileSync(FIXTURES, "utf8"));
  assert.ok(Array.isArray(raw), `${FIXTURES} is not an array of fixtures`);
  return raw as ConditionFixture[];
}

// A parity proof is only a proof while the corpus still says something: a
// truncated file would let every assertion below pass by never running. The Go
// half asserts the same shape with the same numbers.
test("D483: the shared fixture corpus is substantial and exercises both verdicts", () => {
  const fixtures = loadFixtures();
  const names = new Set(fixtures.map((f) => f.name));
  assert.equal(names.size, fixtures.length, "duplicate fixture name — names identify a case in both languages' output");
  const valid = fixtures.filter((f) => f.valid).length;
  const invalid = fixtures.length - valid;
  assert.ok(fixtures.length >= 20, `the fixture corpus shrank to ${fixtures.length} cases`);
  assert.ok(valid >= 8 && invalid >= 8, `corpus is lopsided: ${valid} valid, ${invalid} invalid`);
});

test("D483: every fixture gets the verdict the file records — the TypeScript half", () => {
  for (const fixture of loadFixtures()) {
    const result = validateAlertCondition(fixture.condition);
    if (fixture.valid) {
      assert.ok(
        result.ok,
        `${fixture.name}: the fixture file says valid, validateAlertCondition rejected it — ${
          result.ok ? "" : result.error
        }`,
      );
      // A rejection is a string the UI can print; an acceptance must hand back a
      // usable condition, not just a boolean.
      assert.equal(result.condition.source, (fixture.condition as { source: string }).source);
    } else {
      assert.ok(
        !result.ok,
        `${fixture.name}: the fixture file says invalid, validateAlertCondition accepted it`,
      );
      assert.ok(result.error.length > 0, `${fixture.name}: a refusal with no sentence is not renderable (D430)`);
    }
  }
});

// ---- the vocabularies, mirrored in Go ---------------------------------------
//
// D385 precedent (series-cap.parity.test.ts): read the Go source's REAL
// declaration and compare it against what this side exports — never restate the
// Go values as a second TypeScript constant, which would be a third place to
// update. The fixture file decides the cases it names; this closes the gap for a
// vocabulary entry no fixture happens to mention.

function goStringSlice(source: string, name: string): string[] {
  const match = source.match(new RegExp(`var ${name} = \\[\\]string\\{([^}]*)\\}`));
  assert.ok(match, `condition.go's ${name} moved or was renamed — update this regex, do not restate the values`);
  return [...match![1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

test("D482/D390: condition.go's vocabularies are the ones this module exports", () => {
  const source = readFileSync(CONDITION_GO, "utf8");
  assert.deepEqual(goStringSlice(source, "alertWindows"), [...ALERT_WINDOWS], "the D482 window vocabulary has drifted");
  assert.deepEqual(goStringSlice(source, "alertOps"), [...ALERT_OPS], "the operator vocabulary has drifted");
  assert.deepEqual(goStringSlice(source, "traceSignals"), [...TRACE_SIGNALS], "the D481 trace signals have drifted");
});

test("D390: condition.go's agg-validity mirror still matches VALID_AGGS, the one authority", () => {
  const source = readFileSync(CONDITION_GO, "utf8");
  const block = source.match(/var validAggs = map\[string\]\[\]string\{([\s\S]*?)\n\}/);
  assert.ok(block, "condition.go's validAggs moved or was renamed — update this regex, do not restate the table");
  const goTable: Record<string, string[]> = {};
  for (const line of block![1].split("\n")) {
    const entry = line.match(/"(\w+)":\s*\{([^}]*)\}/);
    if (entry) goTable[entry[1]] = [...entry[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }
  assert.deepEqual(
    goTable,
    { gauge: [...VALID_AGGS.gauge], sum: [...VALID_AGGS.sum], histogram: [...VALID_AGGS.histogram] },
    "the Go mirror of the agg-validity table has drifted from lib/metrics-types.ts's VALID_AGGS (D390)",
  );
  assert.deepEqual(Object.keys(goTable), [...METRIC_TYPES], "the metric type vocabulary has drifted");
});

// ---- the module's own shape --------------------------------------------------

test("D366: alert-types.ts stays client-safe — its only import is metrics-types", () => {
  const source = readFileSync(path.join(HERE, "alert-types.ts"), "utf8");
  const imports = [...source.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(
    imports,
    ["./metrics-types"],
    "alert-types.ts pulled in another module — a client component cannot import a server-only module for a type alone (D10), and the contract file must stay importable from both sides",
  );
  // The bare side-effect form has no `from`, so the sweep above cannot see it.
  // (The word itself appears in this module's header, explaining why it is absent.)
  assert.ok(!/^import ["']server-only["'];?$/m.test(source), "alert-types.ts must never be server-only");
});

// ---- the formatter -----------------------------------------------------------

test("packet §0: the condition string is rendered from the structure, one formatter", () => {
  const metric: AlertCondition = {
    source: "metric",
    metric: "http.requests",
    type: "sum",
    agg: "rate",
    window: "5m",
    op: ">",
    threshold: 100,
    filters: {},
  };
  assert.equal(formatAlertCondition(metric), "sum(rate) http.requests > 100 over 5m");
  assert.equal(
    formatAlertCondition({ ...metric, filters: { "service.name": "checkout", env: "prod" } }),
    "sum(rate) http.requests > 100 over 5m · env=prod service.name=checkout",
  );
  assert.equal(
    formatAlertCondition({ source: "trace", signal: "error_rate_pct", service: "checkout", window: "15m", op: ">", threshold: 5 }),
    "error_rate_pct > 5 over 15m · service checkout",
  );
  assert.equal(
    formatAlertCondition({ source: "trace", signal: "p95_ms", service: null, window: "1h", op: "<", threshold: 900 }),
    "p95_ms < 900 over 1h · all services",
  );
});

test("packet §0: the rendered string does not depend on JSON key order", () => {
  const a: AlertCondition = {
    source: "metric",
    metric: "http.requests",
    type: "sum",
    agg: "rate",
    window: "5m",
    op: ">",
    threshold: 100,
    filters: { env: "prod", "service.name": "checkout" },
  };
  const b: AlertCondition = { ...a, filters: { "service.name": "checkout", env: "prod" } };
  assert.equal(formatAlertCondition(a), formatAlertCondition(b));
});

test("every accepted fixture renders — the rules list can never fail to draw a stored rule", () => {
  for (const fixture of loadFixtures()) {
    const result = validateAlertCondition(fixture.condition);
    if (!result.ok) continue;
    const rendered = formatAlertCondition(result.condition);
    assert.ok(rendered.length > 0, `${fixture.name}: rendered to nothing`);
    assert.ok(
      rendered.includes(result.condition.window) && rendered.includes(String(result.condition.threshold)),
      `${fixture.name}: the rendered string hides the window or the threshold — "${rendered}"`,
    );
  }
});
