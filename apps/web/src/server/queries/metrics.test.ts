import assert from "node:assert/strict";
import test from "node:test";
import { forWorkspace } from "@/server/clickhouse";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { histogramQuantile, listMetricCatalog, queryMetricSeries } from "./metrics";

// run with: npm test --workspace apps/web -- metrics
//
// Hermetic (D96/D113), like tenancy.test.ts: nothing here needs a live
// ClickHouse. The seeded-server half of the same contract lives in
// metrics.integration.test.ts.

// ---- histogram quantile (packet §5 condition 3) -----------------------------
//
// Known distribution: bounds=[0,10,20,30,40], counts=[0,10,10,10,10,0] — a
// uniform 40-sample distribution spread evenly over four 10-wide buckets,
// with zero mass in both open-ended edge buckets. Exact expected quantiles by
// hand: p50 = target 20, which is exactly the cumulative count AT the end of
// the (10,20] bucket -> the interpolated value is that bucket's upper edge,
// 20. p90 = target 36, 60% of the way through the (30,40] bucket -> 36.

const KNOWN_BOUNDS = [0, 10, 20, 30, 40];
const KNOWN_COUNTS = [0, 10, 10, 10, 10, 0];

test("histogramQuantile: exact values against a known uniform distribution", () => {
  assert.equal(histogramQuantile(KNOWN_BOUNDS, KNOWN_COUNTS, 0.5), 20);
  assert.equal(histogramQuantile(KNOWN_BOUNDS, KNOWN_COUNTS, 0.9), 36);
  // p25: target 10, exactly the boundary between bucket 1 ((0,10], cum 0->10)
  // and bucket 2 -- falls at fraction 1.0 through bucket 1, value 10.
  assert.equal(histogramQuantile(KNOWN_BOUNDS, KNOWN_COUNTS, 0.25), 10);
  // p12.5: target 5, halfway through bucket 1 ((0,10], cum 0->10) -> 5.
  assert.equal(histogramQuantile(KNOWN_BOUNDS, KNOWN_COUNTS, 0.125), 5);
});

test("histogramQuantile: an all-empty histogram is a gap, never a zero", () => {
  assert.equal(histogramQuantile(KNOWN_BOUNDS, [0, 0, 0, 0, 0, 0], 0.5), null);
});

test("histogramQuantile: mass entirely in an open-ended edge bucket clamps to the known boundary, never extrapolates", () => {
  // All 5 samples below the first finite bound: no lower edge to interpolate
  // from, so the nearest known boundary (bounds[0]) is reported.
  assert.equal(histogramQuantile(KNOWN_BOUNDS, [5, 0, 0, 0, 0, 0], 0.5), 0);
  // All 5 samples above the last finite bound: nearest known boundary is the
  // last bound itself.
  assert.equal(histogramQuantile(KNOWN_BOUNDS, [0, 0, 0, 0, 0, 5], 0.5), 40);
  // A histogram with NO finite bounds (one open bucket, legal OTLP) has no
  // boundary to report at all -- a gap, never a fabricated number.
  assert.equal(histogramQuantile([], [5], 0.5), null);
});

// ---- unscoped-SQL tripwire, proven red per new table (phase plan §9.3) ------
//
// `runScoped` (clickhouse.ts) is the ONE mechanism, already proven generically
// in tenancy.test.ts; this proves it specifically covers metrics' two new
// query-time tables, since T6 is the task that put them behind `forWorkspace`.

test("tripwire: a bare SELECT against obstack.metric_series is refused before any query runs", async () => {
  const ch = forWorkspace("ws_metrics_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT name, type FROM obstack.metric_series"),
    /refusing unscoped SQL/,
  );
});

test("tripwire: a bare SELECT against obstack.metric_points_1m is refused before any query runs", async () => {
  const ch = forWorkspace("ws_metrics_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT sum(sum_delta) FROM obstack.metric_points_1m WHERE name = {metric:String}", {
      metric: "http.requests",
    }),
    /refusing unscoped SQL/,
  );
});

// ---- what the query layer sends (D113: no query names a workspace) ---------

type Call = { sql: string; params: Record<string, unknown> };

function recorder(responder: (sql: string) => unknown[]): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return responder(sql) as Row[];
      },
    },
  };
}

function assertEveryCallScoped(label: string, calls: Call[]): void {
  assert.ok(calls.length > 0, `${label} issued no statements`);
  for (const call of calls) {
    assert.ok(
      call.sql.includes("{workspace_id:"),
      `${label} sent a statement with no workspace placeholder: ${call.sql.trim().split("\n")[0]}`,
    );
    assert.ok(
      !("workspace_id" in call.params),
      `${label} bound a workspace_id of its own — the scope is the only thing allowed to (D113)`,
    );
  }
}

test("listMetricCatalog: one scoped read against metric_series, mapped exactly", async () => {
  const { ch, calls } = recorder((sql) => {
    assert.ok(sql.includes("obstack.metric_series"), "listMetricCatalog did not read metric_series");
    assert.ok(!sql.includes("FINAL"), "listMetricCatalog must never use FINAL (trace_summaries house rule)");
    return [
      {
        name: "http.requests",
        type: "sum",
        unit: "1",
        last_seen_iso: "2026-09-01T00:03Z",
        attr_keys: ["route", "service.name"],
      },
    ];
  });

  const entries = await listMetricCatalog(ch);
  assertEveryCallScoped("listMetricCatalog", calls);
  assert.deepEqual(entries, [
    {
      name: "http.requests",
      type: "sum",
      unit: "1",
      lastSeen: "2026-09-01T00:03Z", // ISO UTC minute, no seconds (formatted server-side)
      attrKeys: ["route", "service.name"],
    },
  ]);
});

// ---- queryMetricSeries: grid, honest gaps, agg validity, top-10 groupBy ----
//
// A fixed, minute-aligned clock removes any flake from the grid math running
// near a real bucket boundary — every expected epoch below is computed by
// the SAME `floor(epochSeconds / bucketSeconds) * bucketSeconds` rule the
// implementation uses, independently, from this fixed instant.

const FIXED_NOW_MS = Date.UTC(2030, 0, 1, 0, 0, 0); // already minute/hour-aligned

async function withFixedNow<T>(run: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => FIXED_NOW_MS;
  try {
    return await run();
  } finally {
    Date.now = real;
  }
}

test("queryMetricSeries: the grid has exactly the contracted width, and an unmatched bucket is null, never 0", async () => {
  const lastBucketEpochS = FIXED_NOW_MS / 1000; // 1h range -> 1m buckets; the current (aligned) bucket
  const { ch, calls } = recorder((sql) => {
    if (sql.includes("obstack.metric_series")) return [{ type: "gauge" }];
    assert.ok(sql.includes("obstack.metric_points_1m"), "queryMetricSeries did not read metric_points_1m");
    assert.ok(!sql.includes("FINAL"), "queryMetricSeries must never use FINAL (trace_summaries house rule)");
    return [
      {
        grp: "",
        bucket_epoch_s: lastBucketEpochS,
        sum_delta: 0,
        gauge_min: 0,
        gauge_max: 0,
        gauge_avg: 7,
        gauge_last: 7,
        bounds: [],
        hist_counts: [],
        h_sum: 0,
        h_count: 0,
      },
    ];
  });

  const { series, totalGroups } = await withFixedNow(() =>
    queryMetricSeries(ch, { metric: "cpu.util", range: "1h", agg: "avg", groupBy: null, filters: {} }),
  );

  assertEveryCallScoped("queryMetricSeries", calls);
  assert.equal(series.length, 1);
  assert.equal(totalGroups, 1, "D381: ungrouped totalGroups mirrors series.length");
  assert.equal(series[0].group, null);
  assert.equal(series[0].points.length, 60, "1h must serve exactly 60 one-minute buckets (D363 §0)");
  const last = series[0].points[59];
  assert.equal(last.t, "00:00");
  assert.equal(last.v, 7);
  // Every OTHER bucket has no matching row and must be an honest null, never 0.
  for (const point of series[0].points.slice(0, 59)) {
    assert.equal(point.v, null, `expected an empty-bucket null, got ${point.v}`);
  }
});

test("queryMetricSeries: every contracted range width, and rate = sum_delta / bucket-seconds", async () => {
  // D363 §0 binds all three widths (1h -> 1m/60, 6h -> 5m/72, 24h -> 15m/96)
  // and defines rate as the bucket's delta over the bucket's OWN seconds, so
  // the same 600 delta reads as a different rate at each width.
  for (const [range, points, bucketSeconds] of [
    ["1h", 60, 60],
    ["6h", 72, 300],
    ["24h", 96, 900],
  ] as const) {
    const { ch } = recorder((sql) => {
      if (sql.includes("obstack.metric_series")) return [{ type: "sum" }];
      return [
        {
          grp: "",
          bucket_epoch_s: FIXED_NOW_MS / 1000,
          sum_delta: 600,
          gauge_min: 0,
          gauge_max: 0,
          gauge_avg: 0,
          gauge_last: 0,
          bounds: [],
          hist_counts: [],
          h_sum: 0,
          h_count: 0,
        },
      ];
    });

    const {
      series: [series],
    } = await withFixedNow(() =>
      queryMetricSeries(ch, { metric: "http.requests", range, agg: "rate", groupBy: null, filters: {} }),
    );
    assert.equal(series.points.length, points, `${range} must serve exactly ${points} buckets (D363 §0)`);
    assert.equal(
      series.points[points - 1].v,
      600 / bucketSeconds,
      `${range}: rate must divide the bucket delta by ${bucketSeconds}s, not by anything else`,
    );
  }
});

test("queryMetricSeries: an unknown metric is an honest empty result, and never issues the data query at all", async () => {
  const { ch, calls } = recorder((sql) => {
    assert.ok(sql.includes("obstack.metric_series"));
    return []; // no such metric for this workspace
  });

  const result = await queryMetricSeries(ch, {
    metric: "no.such.metric",
    range: "1h",
    agg: "avg",
    groupBy: null,
    filters: {},
  });

  assert.deepEqual(result, { series: [], totalGroups: 0 });
  assert.equal(calls.length, 1, "an unresolved metric must short-circuit before the metric_points_1m read");
});

test("queryMetricSeries: an agg invalid for the metric's type is a request error, never a silent coercion", async () => {
  const { ch } = recorder((sql) => {
    assert.ok(sql.includes("obstack.metric_series"));
    return [{ type: "gauge" }];
  });

  await assert.rejects(
    queryMetricSeries(ch, { metric: "cpu.util", range: "1h", agg: "sum", groupBy: null, filters: {} }),
    /invalid aggregation "sum" for metric "cpu.util"/,
  );
});

test("queryMetricSeries: groupBy keeps the top 10 groups by point count, tie-broken deterministically, no synthetic other", async () => {
  const bucketSeconds = 60;
  const lastBucketEpochS = FIXED_NOW_MS / 1000;
  // 15 groups, g00..g14; group gN gets N+1 rows (distinct in-range buckets),
  // so ranking by row count is unambiguous and g14 (15 rows) must survive
  // while g00 (1 row) must not.
  const rows: Record<string, unknown>[] = [];
  for (let g = 0; g < 15; g++) {
    const name = `g${String(g).padStart(2, "0")}`;
    for (let i = 0; i <= g; i++) {
      rows.push({
        grp: name,
        bucket_epoch_s: lastBucketEpochS - i * bucketSeconds,
        sum_delta: 0,
        gauge_min: 0,
        gauge_max: 0,
        gauge_avg: g,
        gauge_last: g,
        bounds: [],
        hist_counts: [],
        h_sum: 0,
        h_count: 0,
      });
    }
  }

  const { ch } = recorder((sql) => {
    if (sql.includes("obstack.metric_series")) return [{ type: "gauge" }];
    assert.ok(sql.includes("mapContains"), "a groupBy query must gate on the attribute actually being present");
    return rows;
  });

  const { series: result, totalGroups } = await withFixedNow(() =>
    queryMetricSeries(ch, {
      metric: "cpu.util",
      range: "1h",
      agg: "avg",
      groupBy: "route",
      filters: {},
    }),
  );

  assert.equal(result.length, 10, "groupBy must cap at the top 10 groups, never more");
  // D381: totalGroups is the PRE-truncation count (15 seeded), not the
  // truncated series.length (10) — the whole point of "top 10 of N".
  assert.equal(totalGroups, 15, "totalGroups must report the count BEFORE the top-10 truncation");
  const returnedGroups: (string | null)[] = result.map((s) => s.group);
  // g05..g14 (6..15 rows) beat g00..g04 (1..5 rows) — exactly the top 10 by count.
  assert.deepEqual(
    returnedGroups,
    ["g14", "g13", "g12", "g11", "g10", "g09", "g08", "g07", "g06", "g05"],
    "top-10 selection is not ranking by point count, descending",
  );
  assert.ok(
    returnedGroups.every((g) => g !== null),
    "groupBy must never fall back to an ungrouped/synthetic entry",
  );
});
