import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TRACE_RANGE_MS } from "@/server/data";
import { PAGE_PARAM } from "./saved-views";
import {
  DEFAULT_TRACE_RANGE,
  EMPTY_TRACES_FILTERS,
  parseTracesUrl,
  pushedUrl,
  syncUrl,
  toTraceFilter,
  traceRangeMs,
  tracesHref,
  tracesSearchString,
  tracesViewFilters,
  type TracesFilters,
  type UrlSync,
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

test("the bar adopts a URL it did not produce and ignores its own echo (carry-forward 2)", () => {
  const mounted: UrlSync = { seen: "q=pool", pending: [] };

  // Back/forward, a link into a filtered view, a view applied elsewhere.
  const external = syncUrl(mounted, "status=error");
  assert.equal(external.adopt, true);
  assert.equal(external.sync.seen, "status=error");

  // The bar's own navigation coming back must not overwrite what the user has
  // typed since — but only once: the same URL reached again later is external.
  const pushed = pushedUrl(mounted, "q=pooled");
  const echo = syncUrl(pushed, "q=pooled");
  assert.equal(echo.adopt, false);
  assert.deepEqual(echo.sync, { seen: "q=pooled", pending: [] });
  assert.equal(syncUrl({ seen: "q=other", pending: [] }, "q=pooled").adopt, true);

  // Two edits in flight at once: each echo is consumed by itself, so a slow
  // first render cannot rewind the second edit.
  const two = pushedUrl(pushedUrl(mounted, "q=po"), "q=pool2");
  const firstEcho = syncUrl(two, "q=po");
  assert.equal(firstEcho.adopt, false);
  assert.deepEqual(firstEcho.sync.pending, ["q=pool2"]);
  assert.equal(syncUrl(firstEcho.sync, "q=pool2").adopt, false);

  // Adopting means the bar moved elsewhere; an echo still in flight for where
  // it was is no longer about its state.
  assert.deepEqual(syncUrl(pushedUrl(mounted, "q=stale"), "range=1h").sync, {
    seen: "range=1h",
    pending: [],
  });

  // A re-render with the same URL is not a change at all.
  assert.deepEqual(syncUrl(mounted, "q=pool"), { adopt: false, sync: mounted });
});
