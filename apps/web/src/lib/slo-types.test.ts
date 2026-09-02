import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AT_RISK_BUDGET_PCT,
  SLO_INDICATOR_KINDS,
  SLO_STATUSES,
  SLO_WINDOWS,
  formatSloObjective,
  sloBudget,
  validateSloIndicator,
} from "./slo-types";

// run with: npm test --workspace apps/web
//
// D517: the SLO indicator schema and the D509 arithmetic exist in two
// languages, and this file is one of the two consumers of the ONE artifact
// that freezes them together (the alert-types.test.ts shape). The fixture
// lives beside the Go half as `testdata`; this side reaches it by relative
// path rather than keeping a copy.
const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/web/src/lib
const REPO_ROOT = path.resolve(HERE, "../../../..");
const FIXTURES = path.join(REPO_ROOT, "services/ingest/internal/alerting/testdata/indicator-fixtures.json");
const INDICATOR_GO = path.join(REPO_ROOT, "services/ingest/internal/alerting/indicator.go");
const MATH_GO = path.join(REPO_ROOT, "services/ingest/internal/alerting/slo_math.go");

interface IndicatorFixture {
  name: string;
  indicator: unknown;
  valid: boolean;
}
interface ArithmeticFixture {
  name: string;
  good: number;
  total: number;
  target: number;
  currentPct: number | null;
  budgetBurnedPct: number | null;
  status: string;
}

function loadFixtures(): { indicators: IndicatorFixture[]; arithmetic: ArithmeticFixture[] } {
  const raw = JSON.parse(readFileSync(FIXTURES, "utf8")) as { indicators: unknown; arithmetic: unknown };
  assert.ok(Array.isArray(raw.indicators) && Array.isArray(raw.arithmetic), `${FIXTURES} is not the {indicators, arithmetic} shape`);
  return raw as { indicators: IndicatorFixture[]; arithmetic: ArithmeticFixture[] };
}

test("D517: the shared fixture corpus is substantial and exercises both verdicts", () => {
  const { indicators, arithmetic } = loadFixtures();
  const names = new Set(indicators.map((f) => f.name));
  assert.equal(names.size, indicators.length, "duplicate fixture name");
  const valid = indicators.filter((f) => f.valid).length;
  const invalid = indicators.length - valid;
  assert.ok(indicators.length >= 20, `the indicator corpus shrank to ${indicators.length} cases`);
  assert.ok(valid >= 8 && invalid >= 8, `corpus is lopsided: ${valid} valid, ${invalid} invalid`);
  assert.ok(arithmetic.length >= 10, `the arithmetic corpus shrank to ${arithmetic.length} cases`);
});

test("D517: every indicator fixture gets the verdict the file records — the TypeScript half", () => {
  for (const fixture of loadFixtures().indicators) {
    const result = validateSloIndicator(fixture.indicator);
    if (fixture.valid) {
      assert.ok(result.ok, `${fixture.name}: the file says valid, validateSloIndicator rejected it — ${result.ok ? "" : result.error}`);
      assert.equal(result.indicator.kind, (fixture.indicator as { kind: string }).kind);
    } else {
      assert.ok(!result.ok, `${fixture.name}: the file says invalid, validateSloIndicator accepted it`);
      assert.ok(result.error.length > 0, `${fixture.name}: a refusal with no sentence is not renderable (D430)`);
    }
  }
});

test("D509: every arithmetic fixture is answered with the SAME numbers and status as the Go half", () => {
  for (const c of loadFixtures().arithmetic) {
    const got = sloBudget(c.good, c.total, c.target);
    assert.equal(got.status, c.status, `${c.name}: status ${got.status}, the file says ${c.status}`);
    assert.equal(got.currentPct, c.currentPct, `${c.name}: currentPct`);
    assert.equal(got.budgetBurnedPct, c.budgetBurnedPct, `${c.name}: budgetBurnedPct`);
  }
});

// ---- the vocabularies, mirrored in Go (the D385/alert-types precedent) -----------

function goStringSlice(source: string, name: string): string[] {
  const match = source.match(new RegExp(`var ${name} = \\[\\]string\\{([^}]*)\\}`));
  assert.ok(match, `indicator.go's ${name} moved or was renamed — update this regex, do not restate the values`);
  return [...match![1].matchAll(/"([^"]*)"|Kind(\w+)/g)].map((m) => m[1] ?? m[2].toLowerCase());
}

test("D505/D507/D508: indicator.go's vocabularies are the ones this module exports", () => {
  const source = readFileSync(INDICATOR_GO, "utf8");
  assert.deepEqual(goStringSlice(source, "sloIndicatorKinds"), [...SLO_INDICATOR_KINDS], "the indicator kinds have drifted");
  assert.deepEqual(goStringSlice(source, "sloWindows"), [...SLO_WINDOWS], "the D507 window vocabulary has drifted");
  assert.deepEqual(goStringSlice(source, "sloStatuses"), [...SLO_STATUSES], "the status vocabulary has drifted");
});

test("D509: slo_math.go's AtRiskBudgetPct is the one this module exports", () => {
  const source = readFileSync(MATH_GO, "utf8");
  const match = source.match(/const AtRiskBudgetPct = ([0-9.]+)/);
  assert.ok(match, "slo_math.go's AtRiskBudgetPct moved or was renamed");
  assert.equal(Number(match![1]), AT_RISK_BUDGET_PCT, "the at-risk threshold has drifted");
});

// ---- the module's own shape ----------------------------------------------------------

test("D366: slo-types.ts stays client-safe with ZERO imports", () => {
  const source = readFileSync(path.join(HERE, "slo-types.ts"), "utf8");
  assert.equal(/^import /m.test(source), false, "slo-types.ts pulled in a module — it must stay importable from both sides");
});

// ---- the formatter ---------------------------------------------------------------------

test("packet §0: the objective sentence is rendered from the structure, one formatter", () => {
  assert.equal(
    formatSloObjective({ kind: "availability", service: "checkout" }, 99.9, "30d"),
    "99.9% of traces without an error span over 30d · service checkout",
  );
  assert.equal(
    formatSloObjective({ kind: "latency", service: null, thresholdMs: 2000 }, 99, "7d"),
    "99% of traces under 2000 ms over 7d · all services",
  );
  assert.equal(
    formatSloObjective({ kind: "latency", service: null, thresholdMs: 2000 }, 99.999, "7d"),
    "99.999% of traces under 2000 ms over 7d · all services",
  );
});

test("every accepted fixture renders — the card can never fail to draw a stored objective", () => {
  for (const fixture of loadFixtures().indicators) {
    const result = validateSloIndicator(fixture.indicator);
    if (!result.ok) continue;
    for (const window of SLO_WINDOWS) {
      const rendered = formatSloObjective(result.indicator, 99.5, window);
      assert.ok(rendered.includes(window) && rendered.includes("99.5%"), `${fixture.name}: "${rendered}"`);
    }
  }
});

test("validateSloIndicator's sentences name the field (D430)", () => {
  const cases: [unknown, string][] = [
    [null, "indicator must be a JSON object"],
    [{ kind: "nope", service: null }, "kind must be one of availability, latency"],
    [{ kind: "availability", service: null, thresholdMs: 5 }, "unknown key thresholdMs for an availability indicator"],
    [{ kind: "latency", service: null }, "missing key thresholdMs for a latency indicator"],
    [{ kind: "availability" }, "missing key service for an availability indicator"],
    [{ kind: "availability", service: " " }, "service must not be empty"],
    [{ kind: "availability", service: 5 }, "service must be a string or null"],
    [{ kind: "latency", service: null, thresholdMs: 0.5 }, "thresholdMs must be a positive whole number of milliseconds"],
  ];
  for (const [value, sentence] of cases) {
    const result = validateSloIndicator(value);
    assert.ok(!result.ok);
    assert.equal(result.error, sentence);
  }
});
