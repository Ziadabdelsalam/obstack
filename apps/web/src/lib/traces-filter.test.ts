import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TRACE_RANGE_MS } from "@/server/data";
import { PAGE_PARAM } from "./saved-views";
import {
  DEFAULT_TRACE_RANGE,
  EMPTY_TRACES_FILTERS,
  parseTracesUrl,
  toTraceFilter,
  traceRangeMs,
  tracesHref,
  tracesSearchString,
  tracesViewFilters,
  type TracesFilters,
} from "./traces-filter";

// run with: node --conditions=react-server --test src/lib/traces-filter.test.ts
//
// The traces list's URL contract: what a link carries, what the facade is
// therefore asked, and how the bar tells its own navigation from one that
// happened underneath it. The list's MATCHING rules are not here — they belong
// to the search contract (server/search-contract.md) and are proven in
// data.test.ts and traces.integration.test.ts; what these tests guard is that
// a control's value survives the trip to the query and back into the inputs.

/** Every control off its default, so nothing can round-trip by being absent. */
const fullFilters: TracesFilters = {
  q: "pool exhaustion",
  status: "error",
  service: "agent-worker",
  model: "gpt-4o-mini",
  minMs: 5000,
  minCost: 0.01,
  maxCost: 1,
  range: "24h",
  page: 3,
};

test("an empty URL is the default filter set, and the default filter set is a bare path", () => {
  assert.deepEqual(parseTracesUrl({}), EMPTY_TRACES_FILTERS);
  assert.equal(tracesSearchString(EMPTY_TRACES_FILTERS), "");
  assert.equal(tracesHref(tracesSearchString(EMPTY_TRACES_FILTERS)), "/app/traces");
});

test("every control round-trips through the URL", () => {
  const search = tracesSearchString(fullFilters);
  assert.deepEqual(
    [...new URLSearchParams(search).keys()].sort(),
    ["maxCost", "minCost", "minMs", "model", PAGE_PARAM, "q", "range", "service", "status"].sort(),
  );
  // A deep link reproduces the view exactly: the parse of what the bar wrote is
  // what the bar held.
  assert.deepEqual(parseTracesUrl(Object.fromEntries(new URLSearchParams(search))), fullFilters);
});

test("the URL is what the facade is asked", () => {
  const search = tracesSearchString(fullFilters);
  assert.deepEqual(toTraceFilter(parseTracesUrl(Object.fromEntries(new URLSearchParams(search)))), {
    q: "pool exhaustion",
    status: "error",
    service: "agent-worker",
    model: "gpt-4o-mini",
    minMs: 5000,
    minCostUsd: 0.01,
    maxCostUsd: 1,
    rangeMs: 24 * 3_600_000,
    page: 3,
  });
});

test("junk in a hand-typed link falls back instead of reaching the facade", () => {
  const filters = parseTracesUrl({
    status: "flaky",
    minMs: "-5",
    minCost: "abc",
    maxCost: "-3",
    range: "99h",
    [PAGE_PARAM]: "0",
    q: ["first", "second"],
    service: "  spaced  ",
  });
  assert.deepEqual(filters, {
    ...EMPTY_TRACES_FILTERS,
    q: "first",
    service: "spaced",
  });
  // -1 is the facade's "unbounded", not a bound of minus one dollar.
  assert.equal(toTraceFilter(filters).maxCostUsd, -1);
});

test("the header's default bound is the facade's default bound (D50)", () => {
  assert.equal(traceRangeMs(DEFAULT_TRACE_RANGE), DEFAULT_TRACE_RANGE_MS);
  assert.equal(toTraceFilter(EMPTY_TRACES_FILTERS).rangeMs, DEFAULT_TRACE_RANGE_MS);
  // The label the header prints IS the parameter, so it cannot drift from the
  // window that was queried.
  assert.equal(parseTracesUrl({ range: "1h" }).range, "1h");
  assert.equal(toTraceFilter({ ...EMPTY_TRACES_FILTERS, range: "1h" }).rangeMs, 3_600_000);
});

test("a prototype member is not a time range (D66)", () => {
  // `range in TRACE_RANGE_HOURS` accepts every name on Object.prototype, so
  // `?range=toString` used to reach `traceRangeMs` and return NaN — which the
  // live query sends as `since_ms` and ClickHouse rejects, a 500 on a
  // hand-typed URL. Every inherited name that a browser can put in a query
  // string, not just the one that was reported.
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    const filters = parseTracesUrl({ range: name });
    assert.equal(filters.range, DEFAULT_TRACE_RANGE, `?range=${name} is not a range`);
    const rangeMs = toTraceFilter(filters).rangeMs;
    assert.equal(Number.isFinite(rangeMs), true, `?range=${name} asked the query for ${rangeMs} ms`);
    assert.equal(rangeMs, DEFAULT_TRACE_RANGE_MS);
  }
});

test("a page number that cannot be an exact offset is not a page (D66's class)", () => {
  // Same failure shape as the range above, reached through the page key: the
  // page becomes `(page - 1) * TRACE_PAGE_SIZE` in the query, and a JavaScript
  // number at that size prints as "2e+23", which ClickHouse rejects — 500 on a
  // hand-typed link. Only exactly-representable pages are pages.
  for (const typed of ["1e21", "99999999999999999999", "Infinity", "1e999"]) {
    assert.equal(parseTracesUrl({ [PAGE_PARAM]: typed }).page, 1, `?${PAGE_PARAM}=${typed}`);
  }
  // The bound is exactness, not smallness: an addressable page still parses,
  // and a fractional one still floors rather than falling back.
  assert.equal(parseTracesUrl({ [PAGE_PARAM]: "9007199254740991" }).page, 9007199254740991);
  assert.equal(parseTracesUrl({ [PAGE_PARAM]: "2.9" }).page, 2);
});

test("the page parameter is the store's PAGE_PARAM, never a second literal (D53)", () => {
  assert.equal(tracesSearchString({ ...EMPTY_TRACES_FILTERS, page: 3 }), `${PAGE_PARAM}=3`);
  assert.equal(parseTracesUrl({ [PAGE_PARAM]: "3" }).page, 3);
  // Page 1 is the absence of the parameter, so the first page is a clean link.
  assert.equal(tracesSearchString({ ...EMPTY_TRACES_FILTERS, page: 1 }), "");
  // What the menu is handed carries the page under that same name, so the
  // store's strip has something to strip.
  assert.deepEqual(tracesViewFilters({ ...EMPTY_TRACES_FILTERS, status: "ok", page: 3 }), {
    status: "ok",
    [PAGE_PARAM]: "3",
  });
});

// The bar's URL-echo reconciliation is asserted in `use-filter-url-sync.test.ts`
// (D72): the rule is shared with `/app/logs` now, so its cases live with the
// module rather than with one surface's vocabulary.
