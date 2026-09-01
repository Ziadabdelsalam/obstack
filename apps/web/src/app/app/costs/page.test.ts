import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// The D367 guard for the costs route, as a SOURCE-TEXT test (D391a — the
// `services/page.test.ts` shape): the rule is what these three files SAY,
// never what their transitive import graph resolves to. Source is also the
// only option available: importing the real modules here would pull
// `next/link` into a `--conditions react-server` process, where React exports
// no `createContext` (explore/page.test.ts, D54(iii)).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const resolve = (file: string) => path.join(HERE, file);
const read = (file: string) => readFileSync(resolve(file), "utf8");

/**
 * Comments stripped, so every claim below is a claim about the CODE, not
 * about the prose explaining it (the doc comments above quote the very
 * banned words and the mock module path this test forbids).
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const PAGE_PATH = resolve("page.tsx");
const LIVE_PATH = resolve("../../../components/costs/CostsLive.tsx");
const PAGE = code(read("page.tsx"));
const MOCK = code(read("../../../components/costs/CostsMock.tsx"));
const LIVE = code(read("../../../components/costs/CostsLive.tsx"));

function assertMockBranchFirst(label: string, body: string): void {
  const branch = body.indexOf('if (dataMode !== "live")');
  const firstAwait = body.indexOf("await ");
  assert.ok(branch >= 0, `${label} has no dataMode branch`);
  assert.ok(firstAwait >= 0, `${label} has no live-only await — the guard would pass vacuously`);
  assert.ok(
    branch < firstAwait,
    `${label} must return its mock component before the first await, so the mock render stays static`,
  );
}

test("the page branches on dataMode and returns the moved mock body first, with today's props", () => {
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <CostsMock \/>;/,
    "the mock branch must return CostsMock with no props, and nothing else",
  );
  assertMockBranchFirst("costs/page.tsx", PAGE);
  assert.ok(
    PAGE.includes("parseCostsRange"),
    "?range= must be parsed through the frozen parseCostsRange (D462), never read raw",
  );
  // D462: the mock render never depends on the URL, so `?range=` must be read
  // strictly AFTER the mock branch — parsing it earlier would move a
  // request-time read ahead of a branch that never needs one.
  const mockBranchAt = PAGE.indexOf('if (dataMode !== "live") return <CostsMock />;');
  // Search from the branch onward, so the top-of-file `import { parseCostsRange
  // }` (necessarily earlier in the text) does not stand in for the CALL.
  const rangeCallAt = PAGE.indexOf("parseCostsRange(", mockBranchAt);
  assert.ok(
    mockBranchAt >= 0 && rangeCallAt > mockBranchAt,
    "?range= must be parsed AFTER the mock branch, not before it (D462)",
  );
});

test("A2/D392: the page and the Live component import no mock module", () => {
  assert.equal(
    resolvedImports(PAGE, PAGE_PATH).some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "the page reads no fixture at all — CostsMock owns that import",
  );
  assert.equal(
    resolvedImports(LIVE, LIVE_PATH).some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "CostsLive must not depend on any mock module",
  );
  assert.equal(LIVE.includes('"use client"'), false, "CostsLive is a server component (D392)");
  assert.ok(MOCK.includes('from "@/mock/economics"'), "the mock body keeps its fixture import");
});

test("the mock body is the untouched page body, moved verbatim", () => {
  assert.match(MOCK, /export function CostsMock\(\)\s*\{/, "CostsMock must take no props");
  // Pinned markers from the original 248-line body: if any of these move or
  // vanish, the verbatim move this test exists to catch has drifted — every
  // one names a fixture-only figure D362 fences out of the live surface, so
  // they can only live here.
  for (const marker of [
    "const aiTotal = 2232;",
    "function marginOf(rev: number, total: number)",
    "customerCosts.map((c) =>",
    "Atlas Support",
    "$347/mo",
    "$31/mo of idle CPU reservation",
    "Revenue via your Stripe connection.",
  ]) {
    assert.ok(MOCK.includes(marker), `CostsMock lost "${marker}"`);
  }
});

test("D472: the frozen headline/heading/footnote copy is present, keyed by range", () => {
  for (const label of ['"24 hours"', '"7 days"', '"30 days"']) {
    assert.ok(LIVE.includes(label), `CostsLive lost the range label ${label}`);
  }
  assert.ok(
    LIVE.includes("`LLM cost · last ${rangeLabel}`"),
    "the headline stat label must read 'LLM cost · last <range>' verbatim",
  );
  assert.ok(
    LIVE.includes("`Spend per ${BUCKET_LABEL[range]} · last ${rangeLabel}`"),
    "the chart heading must read 'Spend per <bucket> · last <range>' verbatim",
  );
  assert.ok(
    LIVE.includes(
      "The first and last bars are partial — they cover the window's edges — so the bars sum to the total above.",
    ),
    "the chart footnote must be present and unconditional, regardless of range",
  );
});

test("D461: the unpriced sentence and the zero-calls empty state are frozen and unpluralized", () => {
  assert.ok(
    LIVE.includes(
      "`${totals.unpricedCalls} calls across ${report.totalUnpricedModels} models carry no price row, so their cost is unknown — not $0.`",
    ),
    // T6 note: this deliberately never pluralizes "calls"/"models" — the
    // drive asserts the literal "1 calls across 1 models carry no price row"
    // form (D467).
    "the D461 sentence must use the frozen 'N calls across M models' template, unpluralized",
  );
  assert.ok(
    LIVE.includes('href="/app/docs/what-obstack-does-not-do"'),
    "the unpriced sentence's link must point at the not-do doc, nowhere else",
  );
  assert.ok(
    LIVE.includes("`No LLM calls in this workspace's traces in the last ${rangeLabel}.`"),
    "the zero-calls empty state must be the frozen sentence",
  );
});

test("the range picker links mark the active range with aria-current", () => {
  assert.ok(
    LIVE.includes('aria-current={r === range ? "page" : undefined}'),
    "the active range link must carry aria-current, the rest must not",
  );
  assert.ok(LIVE.includes("`/app/costs?range=${r}`"), "each picker link must target ?range=<r>");
});

test("D362: no fenced-out figure appears anywhere in CostsLive's source", () => {
  assert.doesNotMatch(
    LIVE,
    /Meridian|Stripe|revenue|margin|infraCost|featureCosts|aiTotal|\$412/,
    "CostsLive must carry none of the fenced-out mock figures (customers, revenue, margin, infra $, features, forecasts)",
  );
});

test("data-tour=\"costs\" survives in both the mock and the live surface", () => {
  assert.ok(MOCK.includes('data-tour="costs"'), "CostsMock dropped data-tour=\"costs\"");
  assert.ok(LIVE.includes('data-tour="costs"'), "CostsLive dropped data-tour=\"costs\"");
});
