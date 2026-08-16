import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TRACE_RANGE_MS, TRACE_PAGE_SIZE } from "@/server/data";
import { HOSTILE_URL_VALUES, type HostileUrlValue } from "@/lib/hostile-url-values";
import { PAGE_PARAM } from "./saved-views";
import {
  DEFAULT_TRACE_RANGE,
  EMPTY_TRACES_FILTERS,
  TRACE_RANGE_HOURS,
  TRACE_STATUSES,
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

// ---- D68 totality: the shared hostile corpus, every value in every parameter

/** Short, stable label for a message — the corpus holds a 5000-character value. */
function label(value: HostileUrlValue): string {
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  return value.length > 24 ? `${value.slice(0, 24)}…(${value.length} chars)` : JSON.stringify(value);
}

/**
 * The three kinds of parameter this contract has, split by what "in domain"
 * MEANS for each — the split is the property, not a convenience:
 *
 * - CLOSED (`status`, `range`) hold one of a fixed set, so hostile input can
 *   never become the value; it must fall back to the default.
 * - OPEN (`q`, `service`, `model`) must ACCEPT the input verbatim: `?service=
 *   toString` is a real filter that matches nothing, and asserting a default
 *   there would assert a falsehood (D68).
 * - NUMERIC (`minMs`, `minCost`, `maxCost`, the page key) become bounds the
 *   database evaluates, and this is the surface where the corpus's numeric
 *   members are live ammunition rather than near-inert — `/app/traces` has now
 *   answered 500 three times on this one class. So each numeric field is
 *   asserted in domain AND the values DERIVED from them are asserted to be safe
 *   integers, because the derived form is what the query layer binds
 *   (`min_ns:UInt64`, `offset:UInt32`) and the derived form is what reaches
 *   ClickHouse as exponential notation it cannot parse (D73).
 */
const CLOSED_PARAMS = ["status", "range"] as const;
const OPEN_PARAMS = ["q", "service", "model"] as const;
const NUMERIC_PARAMS = ["minMs", "minCost", "maxCost", PAGE_PARAM] as const;

/** The nanosecond bound `queries/traces.ts` derives from `minMs` and binds UInt64. */
const minNs = (filters: TracesFilters): number => Math.round(filters.minMs * 1_000_000);

/** The offset `queries/traces.ts` derives from the page and binds UInt32. */
const offset = (filters: TracesFilters): number => (filters.page - 1) * TRACE_PAGE_SIZE;

test("D68 totality: no corpus value in any parameter escapes the contract's domain", () => {
  // S2.0 L1: everything below is a loop, and a loop over an empty corpus is
  // green by vacuity. The fixture's size and its load-bearing members are
  // asserted BEFORE anything iterates, so a corpus that shrank — or lost the
  // exponential values that caused the real 500s — fails here rather than
  // silently weakening every surface that inherits it.
  assert.equal(HOSTILE_URL_VALUES.length, 15, "the D68 corpus changed size; the ruling fixes its contents");
  for (const required of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__", "1e21", "99999999999999999999", "1e999", "NaN", ""]) {
    assert.ok(HOSTILE_URL_VALUES.includes(required), `the corpus lost ${JSON.stringify(required)}`);
  }
  assert.ok(
    HOSTILE_URL_VALUES.some((v) => Array.isArray(v)),
    "the corpus lost its repeated-parameter value — the one shape only a router produces",
  );
  assert.ok(
    HOSTILE_URL_VALUES.some((v) => typeof v === "string" && v.length >= 5000),
    "the corpus lost its long value",
  );

  for (const value of HOSTILE_URL_VALUES) {
    for (const param of [...CLOSED_PARAMS, ...OPEN_PARAMS, ...NUMERIC_PARAMS]) {
      const at = `?${param}=${label(value)}`;

      // (a) never throws
      const parsed = ((): TracesFilters => {
        try {
          return parseTracesUrl({ [param]: value });
        } catch (error) {
          assert.fail(`${at} threw ${String(error)} — a parse must never throw (D68)`);
        }
      })();

      // (b) closed fields hold a member of their vocabulary AND, because no
      // corpus value is a legal member, their default.
      assert.ok(TRACE_STATUSES.includes(parsed.status), `${at} left status outside its vocabulary: ${parsed.status}`);
      assert.ok(Object.hasOwn(TRACE_RANGE_HOURS, parsed.range), `${at} left range outside its vocabulary: ${parsed.range}`);
      assert.equal(parsed.status, "all", `${at} did not fall back to the default status`);
      assert.equal(parsed.range, DEFAULT_TRACE_RANGE, `${at} did not fall back to the default range`);

      // (c) numeric fields, and the bounds derived from them. A page is an
      // integer ≥ 1 whose offset is exact; a duration is a bound whose
      // nanosecond form is exact; the costs are finite, `maxCost` either a real
      // ceiling or the facade's -1 for unbounded.
      assert.ok(Number.isSafeInteger(parsed.page) && parsed.page >= 1, `${at} produced page ${parsed.page}`);
      assert.ok(Number.isSafeInteger(offset(parsed)), `${at} produced the inexact offset ${offset(parsed)}`);
      assert.ok(Number.isFinite(parsed.minMs) && parsed.minMs >= 0, `${at} produced minMs ${parsed.minMs}`);
      assert.ok(Number.isSafeInteger(minNs(parsed)), `${at} produced the inexact duration bound ${minNs(parsed)} ns`);
      assert.ok(Number.isFinite(parsed.minCost) && parsed.minCost >= 0, `${at} produced minCost ${parsed.minCost}`);
      assert.ok(
        Number.isFinite(parsed.maxCost) && (parsed.maxCost >= 0 || parsed.maxCost === -1),
        `${at} produced maxCost ${parsed.maxCost}`,
      );

      // (d) the open fields accept the value — first-of-repeated, trimmed — and
      // the parameters that were not attacked stay at their defaults.
      const accepted = (Array.isArray(value) ? value[0] : value).trim();
      for (const open of OPEN_PARAMS) {
        const expected = param === open ? accepted : "";
        assert.equal(parsed[open], expected, `${at}: ${open} is ${JSON.stringify(parsed[open])}`);
      }

      // ...and whatever survived round-trips through the URL unchanged, so an
      // accepted hostile string cannot mean one thing in a link and another in
      // the bar that re-serializes it.
      assert.deepEqual(
        parseTracesUrl(Object.fromEntries(new URLSearchParams(tracesSearchString(parsed)))),
        parsed,
        `${at} did not survive a serialize/parse round trip`,
      );
    }
  }
});

test("a duration bound that cannot be applied exactly is not a bound (D73)", () => {
  // `minMs` becomes `min_ns = minMs * 1e6`, bound as UInt64. Measured: 1e21 ms
  // reached ClickHouse as the string "1e+27" and `/app/traces?minMs=1e21`
  // answered 500 — the same defect as the range and the page, one parameter
  // over, found by the corpus above on its first application here.
  for (const typed of ["1e21", "99999999999999999999", "1e15", "1e999", "Infinity"]) {
    assert.equal(parseTracesUrl({ minMs: typed }).minMs, 0, `?minMs=${typed}`);
  }
  // The bound is exactness of the DERIVED value, not smallness of the typed
  // one: a duration whose nanosecond form is still a safe integer survives,
  // fractions included, and the shipped control values are untouched.
  assert.equal(parseTracesUrl({ minMs: "1.9" }).minMs, 1.9);
  assert.equal(parseTracesUrl({ minMs: "9007199254" }).minMs, 9007199254);
  for (const shipped of [1000, 5000, 10000]) {
    assert.equal(parseTracesUrl({ minMs: String(shipped) }).minMs, shipped);
  }
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
