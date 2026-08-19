import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LayerDot } from "@/components/ui/LayerChip";
import { layerColor } from "@/lib/layers";
import { NOW } from "@/mock/generate";
import type { Trace } from "@/lib/types";
import type { QueryResultRow } from "pg";
import {
  EMPTY_TRACES_FILTERS,
  PAGE_PARAM,
  TRACES_PATH,
  parseTracesUrl,
  toTraceFilter,
  tracesHref,
  tracesSearchString,
  tracesViewFilters,
  type TracesFilters,
} from "@/lib/traces-filter";
import {
  TRACE_PAGE_SIZE,
  dataForSession,
  dataMode,
  mockSearchTraces,
  type TraceFilter,
} from "@/server/data";
import { listSavedViews, saveSavedView, type SavedView } from "@/server/saved-views";
import type { QueryRows } from "@/server/postgres";

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
  // The page's own entry point since D126 deleted the facade call-throughs: in
  // mock mode `dataForSession` short-circuits on the mode check and never
  // reaches a session or Postgres (D114), which is what lets this run here.
  const data = await dataForSession();
  // The URL's default parse asks for exactly what the pre-D44 page asked for.
  const fromUrl = await data.searchTraces(toTraceFilter(parseTracesUrl({})));
  const fromDefaults = await data.searchTraces();
  assert.ok(fromUrl.traces.length > 0);
  assert.deepEqual(ids(fromUrl), ids(fromDefaults));
  assert.equal(fromUrl.total, fromDefaults.total);
});

test("a live query with no matches is an empty result, not a fallback (D13)", async () => {
  const data = await dataForSession();
  const empty = await data.searchTraces(toTraceFilter(parseTracesUrl({ q: "no-such-token-anywhere" })));
  assert.deepEqual(empty.traces, []);
  assert.equal(empty.total, 0);
});

/**
 * A `saved_views` stand-in: it holds the rows the store writes and answers the
 * store's own SELECT, honouring the workspace and surface it binds. Enough to
 * carry a filter set across the store and back at this seam — the store's SQL
 * against a real Postgres is `server/saved-views.test.ts`'s subject, and no
 * Postgres is needed here (`web`'s skip trap allows no skips).
 */
function tableBackedQuery() {
  const rows: { workspaceId: string; surface: string; name: string; filters: string }[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    const [workspaceId, surface] = params as string[];
    if (sql.includes("INSERT INTO saved_views")) {
      const [, , name, filters] = params as string[];
      rows.push({ workspaceId, surface, name, filters });
      return [];
    }
    return rows
      .filter((r) => r.workspaceId === workspaceId && r.surface === surface)
      .map((r) => ({ name: r.name, filters: JSON.parse(r.filters) })) as unknown as Row[];
  };
  return query;
}

test("a view saved from the bar comes back whole, applies whole, and never carries the page", async () => {
  const query = tableBackedQuery();
  const onPageThree: TracesFilters = {
    ...EMPTY_TRACES_FILTERS,
    q: "pool",
    status: "error",
    range: "24h",
    page: 3,
  };
  await saveSavedView("ws_a", "traces", "escalations", tracesViewFilters(onPageThree), query);

  // Reopening the menu is another read of the workspace's rows — nothing is
  // held in memory between the two calls.
  const [view, ...rest]: SavedView[] = await listSavedViews("ws_a", "traces", query);
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

  // Probe: the assertions above observed the store, not a constant — another
  // workspace's menu shows nothing of this one's (D116).
  assert.deepEqual(await listSavedViews("ws_b", "traces", query), []);
});

// ---------------------------------------------------------------------------
// D63: the command palette links into this surface, so its hrefs are part of
// this surface's URL contract. They are read out of the palette's source rather
// than restated here — a copy would drift exactly where the ruling says the
// entries must stay true.

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PALETTE = path.join(SRC_ROOT, "components/shell/CommandPalette.tsx");

const paletteItems = [
  ...readFileSync(PALETTE, "utf8").matchAll(
    /label:\s*"((?:[^"\\]|\\.)*)",\s*hint:\s*"((?:[^"\\]|\\.)*)",\s*href:\s*"((?:[^"\\]|\\.)*)"/g,
  ),
].map(([, label, hint, href]) => ({ label, hint, href }));

/**
 * A keep/drop pair per filter dimension a palette link can move. Derived from
 * the link's own parsed value, so the rows cannot agree with a stale copy of
 * the href; a link that moves a dimension with no pair here fails rather than
 * passing unchecked.
 */
const controlRows: {
  dimension: keyof TracesFilters;
  rows: (filters: TracesFilters) => [Partial<Trace>, Partial<Trace>];
}[] = [
  {
    dimension: "status",
    rows: (f) => [
      { status: f.status as Trace["status"] },
      { status: f.status === "error" ? "ok" : "error" },
    ],
  },
  {
    dimension: "minMs",
    rows: (f) => [{ durationMs: f.minMs * 2 }, { durationMs: Math.floor(f.minMs / 2) }],
  },
];

test("every command-palette link into the traces list is a real filter on it (D63)", () => {
  assert.ok(
    paletteItems.length > 20,
    `the palette's items no longer parse out of its source (${paletteItems.length} found) — this guard would pass vacuously`,
  );
  const links = paletteItems.filter((i) => i.href.startsWith(`${TRACES_PATH}?`));
  assert.ok(links.length >= 2, `only ${links.length} palette links reach ${TRACES_PATH}`);

  for (const { label, href } of links) {
    const query = href.slice(`${TRACES_PATH}?`.length);
    const filters = parseTracesUrl(Object.fromEntries(new URLSearchParams(query)));

    // Every parameter the href carries is one this surface knows: a name the
    // parse does not recognise falls back to its default and vanishes here.
    assert.deepEqual(
      [...new URLSearchParams(tracesSearchString(filters))].sort(),
      [...new URLSearchParams(query)].sort(),
      `${label}: ${href} is not this surface's parameter vocabulary`,
    );

    const moved = (Object.keys(filters) as (keyof TracesFilters)[]).filter(
      (key) => filters[key] !== EMPTY_TRACES_FILTERS[key],
    );
    assert.notDeepEqual(moved, [], `${label}: the link asks for the unfiltered list`);

    for (const dimension of moved) {
      const control = controlRows.find((c) => c.dimension === dimension);
      assert.ok(control, `${label}: no control rows for ${dimension} — extend this guard`);
      const [keep, drop] = control.rows(filters);
      const rows = [makeTrace({ id: "keep", ...keep }), makeTrace({ id: "drop", ...drop })];
      assert.deepEqual(
        ids(mockSearchTraces(rows, toTraceFilter(EMPTY_TRACES_FILTERS))).sort(),
        ["drop", "keep"],
        `${label}: the control row needs the ${dimension} filter to be dropped`,
      );
      assert.deepEqual(
        ids(mockSearchTraces(rows, toTraceFilter(filters))),
        ["keep"],
        `${label}: the link does not narrow on ${dimension}`,
      );
    }
  }
});

/** Every source under `src/`, collected by walking — nothing is listed by hand. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

test("nothing outside the saved-views feature calls a hardcoded filter one of the user's views (D63)", () => {
  const self = path.resolve(fileURLToPath(import.meta.url));
  const files = sourceFiles(SRC_ROOT).filter((f) => f !== self);
  assert.ok(files.length > 50, `the sweep read ${files.length} sources — it is not looking at this app`);

  // The phrase as a quoted string: what a component renders or labels, not the
  // prose around it. Matched a line at a time — a file-wide match would pair
  // the quote of some unrelated className with another one pages away and call
  // every comment a claim. Assembled from parts so this file is not its own hit.
  const claim = new RegExp(`"[^"]*saved ${"view"}s?[^"]*"`, "i");
  const hits = files
    .filter((f) => readFileSync(f, "utf8").split("\n").some((line) => claim.test(line)))
    .map((f) => path.relative(SRC_ROOT, f));

  // Positive control: the matcher does find the phrase where the feature writes
  // it, so the emptiness below is an absence and not a dead regex (S2.0 L1).
  assert.ok(
    hits.includes("components/saved-views/SavedViewsMenu.tsx"),
    `the sweep found no occurrence at all (hits: ${hits.join(", ")})`,
  );
  assert.deepEqual(
    hits.filter((f) => !f.includes("saved-views")),
    [],
    "a view is one the user saved and can delete; a hardcoded filter is a filter",
  );
});
