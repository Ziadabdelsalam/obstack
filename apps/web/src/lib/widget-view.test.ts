import assert from "node:assert/strict";
import test from "node:test";
import type { MetricSeriesPoint, MetricSeriesResult } from "./metrics-types";
import type { Dashboard, DashboardWidget } from "./dashboard-types";
import {
  cardCaption,
  foldCaption,
  foldSeries,
  groupRows,
  groupsCaption,
  isEmptyResult,
  pinnedWidgets,
  statView,
  widgetQuery,
} from "./widget-view";

// run with: npm test --workspace apps/web -- widget-view
//
// Pure (D428): every rule D427 states — the fold per agg, `n of N`, ordering,
// the D381 truncation caption — is provable here without a DOM.

function widget(overrides: Partial<DashboardWidget> = {}): DashboardWidget {
  return {
    id: "wdg_0000000000000001",
    title: "requests",
    kind: "stat",
    metric: "http.requests",
    type: "sum",
    agg: "sum",
    range: "6h",
    groupBy: null,
    pinned: false,
    ...overrides,
  };
}

// A series with a leading AND a trailing null, so `last` cannot be confused
// with "the last bucket" and sum/min/max/mean cannot be confused with
// including the gaps.
const LEADING_TRAILING_NULLS: MetricSeriesPoint[] = [
  { t: "00:00", v: null },
  { t: "00:05", v: 10 },
  { t: "00:10", v: null },
  { t: "00:15", v: 20 },
  { t: "00:20", v: null },
];

// ---- foldSeries: one fold per agg, at the boundaries -----------------------

test("foldSeries: sum folds the non-null values only, ignoring gaps", () => {
  const fold = foldSeries(LEADING_TRAILING_NULLS, "sum");
  assert.deepEqual(fold, { kind: "sum", value: 30, n: 2, total: 5, t: null });
});

test("foldSeries: min/max fold the non-null values only", () => {
  assert.equal(foldSeries(LEADING_TRAILING_NULLS, "min").value, 10);
  assert.equal(foldSeries(LEADING_TRAILING_NULLS, "max").value, 20);
});

test("foldSeries: avg/rate/p50/p90/p95/p99 all fold to the arithmetic mean of the non-null values", () => {
  for (const agg of ["avg", "rate", "p50", "p90", "p95", "p99"] as const) {
    const fold = foldSeries(LEADING_TRAILING_NULLS, agg);
    assert.equal(fold.kind, "mean");
    assert.equal(fold.value, 15);
  }
});

test("foldSeries: last picks the LAST non-null point, not the last bucket", () => {
  const fold = foldSeries(LEADING_TRAILING_NULLS, "last");
  // The last bucket (00:20) is null; the last point WITH data is 00:15 -> 20.
  assert.deepEqual(fold, { kind: "last", value: 20, n: 2, total: 5, t: "00:15" });
});

test("foldSeries: n of N counts non-null buckets against the total grid width", () => {
  const fold = foldSeries(LEADING_TRAILING_NULLS, "sum");
  assert.equal(fold.n, 2);
  assert.equal(fold.total, 5);
});

test("foldSeries: an all-null series folds to empty (value null) for every agg kind, never 0", () => {
  const allNull: MetricSeriesPoint[] = [
    { t: "00:00", v: null },
    { t: "00:05", v: null },
    { t: "00:10", v: null },
  ];
  for (const agg of ["sum", "min", "max", "last", "avg"] as const) {
    const fold = foldSeries(allNull, agg);
    assert.equal(fold.value, null);
    assert.equal(fold.n, 0);
    assert.equal(fold.total, 3);
    assert.equal(fold.t, null);
  }
});

test("foldSeries: an empty points array folds to empty with total 0", () => {
  const fold = foldSeries([], "sum");
  assert.deepEqual(fold, { kind: "sum", value: null, n: 0, total: 0, t: null });
});

// ---- foldCaption: the exact D427 wording ------------------------------------

test("foldCaption: {kind} · last {range} · {n} of {N} buckets had data for sum/min/max/mean", () => {
  const fold = foldSeries(LEADING_TRAILING_NULLS, "sum");
  assert.equal(foldCaption(fold, "6h"), "sum · last 6h · 2 of 5 buckets had data");
});

test("foldCaption: latest · as of {t} · last {range} for last", () => {
  const fold = foldSeries(LEADING_TRAILING_NULLS, "last");
  assert.equal(foldCaption(fold, "1h"), "latest · as of 00:15 · last 1h");
});

// ---- isEmptyResult / statView -----------------------------------------------

test("isEmptyResult: zero series is empty", () => {
  assert.equal(isEmptyResult({ series: [], totalGroups: 0 }), true);
});

test("isEmptyResult: every point in every series null is empty", () => {
  const result: MetricSeriesResult = {
    series: [
      { group: "a", points: [{ t: "00:00", v: null }] },
      { group: "b", points: [{ t: "00:00", v: null }] },
    ],
    totalGroups: 2,
  };
  assert.equal(isEmptyResult(result), true);
});

test("isEmptyResult: any non-null point anywhere is not empty", () => {
  const result: MetricSeriesResult = {
    series: [
      { group: "a", points: [{ t: "00:00", v: null }] },
      { group: "b", points: [{ t: "00:00", v: 1 }] },
    ],
    totalGroups: 2,
  };
  assert.equal(isEmptyResult(result), false);
});

test("statView: all-null series -> empty, no fabricated value", () => {
  const result: MetricSeriesResult = { series: [{ group: null, points: [{ t: "00:00", v: null }] }], totalGroups: 1 };
  assert.deepEqual(statView(result, widget({ agg: "sum" })), { empty: true });
});

test("statView: folds the single series with the widget's agg and range", () => {
  const result: MetricSeriesResult = { series: [{ group: null, points: LEADING_TRAILING_NULLS }], totalGroups: 1 };
  const view = statView(result, widget({ agg: "max", range: "24h" }));
  assert.deepEqual(view, { empty: false, value: 20, caption: "max · last 24h · 2 of 5 buckets had data" });
});

// ---- groupRows: ordering, ties, totalGroups passthrough ---------------------

test("groupRows: ordered by folded value desc", () => {
  const result: MetricSeriesResult = {
    series: [
      { group: "svc-b", points: [{ t: "00:00", v: 5 }] },
      { group: "svc-a", points: [{ t: "00:00", v: 20 }] },
      { group: "svc-c", points: [{ t: "00:00", v: 10 }] },
    ],
    totalGroups: 3,
  };
  const view = groupRows(result, widget({ kind: "topn", agg: "sum", groupBy: "service.name" }));
  assert.deepEqual(
    view.rows.map((r) => r.group),
    ["svc-a", "svc-c", "svc-b"],
  );
});

test("groupRows: ties in folded value break by group name ascending", () => {
  const result: MetricSeriesResult = {
    series: [
      { group: "zebra", points: [{ t: "00:00", v: 10 }] },
      { group: "alpha", points: [{ t: "00:00", v: 10 }] },
      { group: "mid", points: [{ t: "00:00", v: 10 }] },
    ],
    totalGroups: 3,
  };
  const view = groupRows(result, widget({ kind: "table", agg: "sum", groupBy: "service.name" }));
  assert.deepEqual(
    view.rows.map((r) => r.group),
    ["alpha", "mid", "zebra"],
  );
});

test("groupRows: totalGroups is passed through untouched (D381), independent of how many rows the query returned", () => {
  const result: MetricSeriesResult = {
    series: [
      { group: "a", points: [{ t: "00:00", v: 1 }] },
      { group: "b", points: [{ t: "00:00", v: 2 }] },
    ],
    totalGroups: 47,
  };
  const view = groupRows(result, widget({ kind: "topn", agg: "sum", groupBy: "service.name" }));
  assert.equal(view.totalGroups, 47);
  assert.equal(view.rows.length, 2);
});

test("groupsCaption: showing {shown} of {totalGroups} groups only when truncated", () => {
  assert.equal(groupsCaption(10, 47), "showing 10 of 47 groups");
  assert.equal(groupsCaption(3, 3), null);
});

// ---- cardCaption: ONE caption per topn/table card ----------------------------

// Two groups whose gaps do not line up: the card had data in 2 of the 3
// buckets even though neither group did on its own.
const TWO_SPARSE_GROUPS: MetricSeriesResult = {
  series: [
    {
      group: "svc-a",
      points: [
        { t: "00:00", v: 1 },
        { t: "00:05", v: null },
        { t: "00:10", v: null },
      ],
    },
    {
      group: "svc-b",
      points: [
        { t: "00:00", v: null },
        { t: "00:05", v: 2 },
        { t: "00:10", v: null },
      ],
    },
  ],
  totalGroups: 2,
};

test("cardCaption: one caption for the whole card, counting buckets with data anywhere on it", () => {
  const w = widget({ kind: "topn", agg: "sum", groupBy: "service.name" });
  assert.equal(cardCaption(TWO_SPARSE_GROUPS, w), "sum · last 6h · 2 of 3 buckets had data");
});

test("cardCaption: for last, as of is the newest bucket with any data on the card", () => {
  const w = widget({ kind: "table", agg: "last", groupBy: "service.name" });
  assert.equal(cardCaption(TWO_SPARSE_GROUPS, w), "latest · as of 00:05 · last 6h");
});

// ---- pinnedWidgets: dashboard order, then widget index ----------------------

test("pinnedWidgets: dashboard list order, then widget index within each dashboard", () => {
  const dashboards: Dashboard[] = [
    {
      id: "dash_1",
      name: "First",
      updatedAt: "2026-09-01T00:00:00Z",
      widgets: [
        widget({ id: "wdg_1a", pinned: false }),
        widget({ id: "wdg_1b", pinned: true }),
        widget({ id: "wdg_1c", pinned: true }),
      ],
    },
    {
      id: "dash_2",
      name: "Second",
      updatedAt: "2026-09-01T00:00:00Z",
      widgets: [widget({ id: "wdg_2a", pinned: true })],
    },
  ];
  const pinned = pinnedWidgets(dashboards);
  assert.deepEqual(
    pinned.map((p) => [p.dashboardId, p.widget.id]),
    [
      ["dash_1", "wdg_1b"],
      ["dash_1", "wdg_1c"],
      ["dash_2", "wdg_2a"],
    ],
  );
  assert.equal(pinned[0].dashboardName, "First");
});

test("pinnedWidgets: a dashboard with nothing pinned contributes nothing", () => {
  const dashboards: Dashboard[] = [
    { id: "dash_1", name: "Empty", updatedAt: "2026-09-01T00:00:00Z", widgets: [widget({ pinned: false })] },
  ];
  assert.deepEqual(pinnedWidgets(dashboards), []);
});

// ---- widgetQuery: filters always {} -----------------------------------------

test("widgetQuery: sends filters: {} (fence 10 — a widget never stores filters)", () => {
  const w = widget({ metric: "cpu.pct", type: "gauge", agg: "avg", range: "1h", groupBy: "host" });
  assert.deepEqual(widgetQuery(w), {
    metric: "cpu.pct",
    type: "gauge",
    range: "1h",
    agg: "avg",
    groupBy: "host",
    filters: {},
  });
});
