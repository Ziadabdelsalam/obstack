import assert from "node:assert/strict";
import test from "node:test";
import { LayerDot } from "@/components/ui/LayerChip";
import { layerColor } from "@/lib/layers";
import { NOW } from "@/mock/generate";
import type { Trace } from "@/lib/types";
import {
  PAGE_PARAM,
  readSavedViews,
  saveView,
  SAVED_VIEWS_STORAGE_KEY,
} from "@/lib/saved-views";
import {
  EMPTY_TRACES_FILTERS,
  parseTracesUrl,
  toTraceFilter,
  tracesHref,
  tracesSearchString,
  tracesViewFilters,
} from "@/lib/traces-filter";
import {
  TRACE_PAGE_SIZE,
  dataMode,
  mockSearchTraces,
  searchTraces,
  type TraceFilter,
} from "@/server/data";

// run with: node --conditions=react-server --test "src/**/*.test.{ts,tsx}"
//
// The traces surface: what a URL asks the facade for, what comes back for the
// header's "N of M", what the pager's page numbers reach, and what a saved view
// carries. `TracesSearch.tsx` itself cannot be imported here and neither can
// `app/traces/page.tsx`: the runner is pinned to `--conditions react-server`
// (server-only needs it), that React build has no `createContext`, and both
// `next/link` and `lucide-react` call it at module scope. So these assertions
// stop at the seam the component is a thin shell over — the URL contract and
// the facade call the page makes — and claim nothing about rendered DOM; there
// is no DOM harness in this repo and D54(iii) refused adding one. The file is
// still `.tsx`: it belongs beside the component, and the runner's glob has to
// find it (D54(i), package.json "//test").

const ids = (result: { traces: Trace[] }): string[] => result.traces.map((t) => t.id);

function makeTrace(overrides: Partial<Trace> & { id: string }): Trace {
  return {
    rootName: "POST /chat",
    method: "POST",
    service: "demo-agent",
    startedAt: new Date(NOW - 60_000).toISOString(),
    durationMs: 100,
    status: "ok",
    spanCount: 1,
    totalTokens: 0,
    costUsd: 0,
    services: ["demo-agent"],
    models: [],
    spans: [],
    logs: [],
    ...overrides,
  };
}

/** More traces than one page, newest first once ordered, all inside the 6h default. */
const manyTraces: Trace[] = Array.from({ length: TRACE_PAGE_SIZE + 20 }, (_, i) =>
  makeTrace({
    id: `t-${String(i).padStart(3, "0")}`,
    startedAt: new Date(NOW - (i + 1) * 60_000).toISOString(),
  }),
);

function pageFromUrl(params: Record<string, string>) {
  return mockSearchTraces(manyTraces, toTraceFilter(parseTracesUrl(params)));
}

test("the runner discovers a .test.tsx and can import a real component module (D54)", () => {
  // The floor of what a component test can be under `--conditions react-server`:
  // a module with no `createContext` in its import graph loads, and TSX in this
  // file compiles against the react-server jsx runtime.
  const element = <LayerDot layer="llm" />;
  assert.equal(element.type, LayerDot);
  assert.deepEqual(LayerDot({ layer: "llm" }).props.style, { background: layerColor.llm });
});

test("the header's total is the data's, not the page's (D44/D21)", () => {
  const first = pageFromUrl({});
  assert.equal(first.traces.length, TRACE_PAGE_SIZE);
  assert.equal(first.total, manyTraces.length);
  // "N of M" with N === M would be the pre-D44 lie: a denominator that only
  // counts what was rendered.
  assert.notEqual(first.total, first.traces.length);
  assert.deepEqual(ids(first), ids(first).slice().sort());
  assert.equal(ids(first)[0], "t-000");
});

test("a deep link to page 2 renders page 2, disjoint and continuing (D44)", () => {
  const first = pageFromUrl({});
  const second = pageFromUrl({ [PAGE_PARAM]: "2" });

  assert.equal(second.traces.length, manyTraces.length - TRACE_PAGE_SIZE);
  assert.equal(second.total, manyTraces.length, "the total is the data's, whatever page is shown");
  assert.equal(ids(second).some((id) => ids(first).includes(id)), false);
  assert.deepEqual(ids(second), manyTraces.slice(TRACE_PAGE_SIZE).map((t) => t.id));

  // Nothing but the URL decided that: the parameters alone reproduce the page.
  assert.deepEqual(pageFromUrl({ [PAGE_PARAM]: "2" }).traces.map((t) => t.id), ids(second));
  // And past the end there is nothing to show, while the total stays the data's.
  const past = pageFromUrl({ [PAGE_PARAM]: "3" });
  assert.deepEqual(past.traces, []);
  assert.equal(past.total, manyTraces.length);
});

/**
 * One row the filter keeps and one it must drop — the control row passes when
 * the parameter is absent, so each case proves the URL's value reached the
 * query rather than passing by accident (S2.0 L1).
 */
const controls: {
  name: string;
  params: Record<string, string>;
  asked: Partial<TraceFilter>;
  keep: Partial<Trace>;
  drop: Partial<Trace>;
}[] = [
  {
    name: "free text",
    params: { q: "planner" },
    asked: { q: "planner" },
    keep: { rootName: "checkout planner" },
    drop: { rootName: "billing sync" },
  },
  {
    name: "status",
    params: { status: "error" },
    asked: { status: "error" },
    keep: { status: "error" },
    drop: { status: "ok" },
  },
  {
    name: "service",
    params: { service: "agent-worker" },
    asked: { service: "agent-worker" },
    keep: { services: ["agent-worker"] },
    drop: { services: ["gateway"] },
  },
  {
    name: "model",
    params: { model: "gpt-4o-mini" },
    asked: { model: "gpt-4o-mini" },
    keep: { models: ["gpt-4o-mini"] },
    drop: { models: ["claude-3-5-sonnet"] },
  },
  {
    name: "duration",
    params: { minMs: "5000" },
    asked: { minMs: 5000 },
    keep: { durationMs: 8000 },
    drop: { durationMs: 800 },
  },
  {
    name: "minimum cost",
    params: { minCost: "0.01" },
    asked: { minCostUsd: 0.01 },
    keep: { costUsd: 0.5 },
    drop: { costUsd: 0.001 },
  },
  {
    name: "maximum cost",
    params: { maxCost: "0.01" },
    asked: { maxCostUsd: 0.01 },
    keep: { costUsd: 0.001 },
    drop: { costUsd: 0.5 },
  },
  {
    name: "time range",
    params: { range: "1h" },
    asked: { rangeMs: 3_600_000 },
    keep: { startedAt: new Date(NOW - 10 * 60_000).toISOString() },
    drop: { startedAt: new Date(NOW - 3 * 3_600_000).toISOString() },
  },
];

for (const control of controls) {
  test(`the ${control.name} control reaches the facade and narrows the list`, () => {
    const rows = [makeTrace({ id: "keep", ...control.keep }), makeTrace({ id: "drop", ...control.drop })];

    const filter = toTraceFilter(parseTracesUrl(control.params));
    const asked = filter as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(control.asked)) {
      assert.deepEqual(asked[key], value, `the facade was not asked for ${key}`);
    }

    const unfiltered = mockSearchTraces(rows, toTraceFilter(EMPTY_TRACES_FILTERS));
    assert.deepEqual(ids(unfiltered).sort(), ["drop", "keep"], "the control row needs the filter");

    const narrowed = mockSearchTraces(rows, filter);
    assert.deepEqual(ids(narrowed), ["keep"]);
    assert.equal(narrowed.total, 1, "the total narrows with the page");
  });
}

test("mock mode's default list is the list the page rendered before (F6/F7)", async () => {
  assert.equal(dataMode, "mock", "run the suite without OBSTACK_DATA_MODE=live");
  // The URL's default parse asks for exactly what the pre-D44 page asked for.
  const fromUrl = await searchTraces(toTraceFilter(parseTracesUrl({})));
  const fromDefaults = await searchTraces();
  assert.ok(fromUrl.traces.length > 0);
  assert.deepEqual(ids(fromUrl), ids(fromDefaults));
  assert.equal(fromUrl.total, fromDefaults.total);
});

test("a live query with no matches is an empty result, not a fallback (D13)", async () => {
  const empty = await searchTraces(toTraceFilter(parseTracesUrl({ q: "no-such-token-anywhere" })));
  assert.deepEqual(empty.traces, []);
  assert.equal(empty.total, 0);
});

/** A `localStorage` stand-in the test can clear, as the store's own tests use. */
function withStorage(run: (entries: Map<string, string>) => void): void {
  const entries = new Map<string, string>();
  const store: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  try {
    run(entries);
  } finally {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  }
}

test("a view saved from the bar survives a reload, applies whole, and never carries the page", () => {
  withStorage((entries) => {
    const onPageThree = {
      ...EMPTY_TRACES_FILTERS,
      q: "pool",
      status: "error" as const,
      range: "24h" as const,
      page: 3,
    };
    saveView("traces", "escalations", tracesViewFilters(onPageThree));

    // A reload is another read of the same storage — nothing is held in memory.
    const [view, ...rest] = readSavedViews("traces");
    assert.deepEqual(rest, []);
    assert.equal(view.name, "escalations");
    assert.equal(PAGE_PARAM in view.filters, false, "a view is a question, not a page (D47/D53)");
    // Exactly the filters, so a page key under any OTHER name — a hand-rolled
    // literal the store's strip cannot see — goes red here too (D53).
    assert.deepEqual(Object.keys(view.filters).sort(), ["q", "range", "status"]);

    // Applying REPLACES the bar's filter state: the service it does not carry
    // ends up unset, and it opens at the first page.
    const applied = parseTracesUrl(view.filters);
    assert.deepEqual(applied, { ...EMPTY_TRACES_FILTERS, q: "pool", status: "error", range: "24h" });
    assert.equal(applied.service, "");
    assert.equal(applied.page, 1);

    // One state, not two: the applied view is a URL, and that URL is what the
    // facade is asked for.
    assert.equal(tracesHref(tracesSearchString(applied)), "/app/traces?q=pool&status=error&range=24h");
    assert.equal(toTraceFilter(applied).q, "pool");
    assert.equal(toTraceFilter(applied).rangeMs, 24 * 3_600_000);

    // Probe: the assertions above observed persistence, not a constant.
    entries.delete(SAVED_VIEWS_STORAGE_KEY);
    assert.deepEqual(readSavedViews("traces"), []);
  });
});
