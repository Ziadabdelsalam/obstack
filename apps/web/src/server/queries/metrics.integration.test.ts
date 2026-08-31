import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { forWorkspace } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of T6's frozen contract (D363 packet §0):
// `listMetricCatalog`/`queryMetricSeries` read `metric_series`/
// `metric_points_1m`, real materialized views over real inserted rows —
// nothing a mocked `ScopedClickHouse` (metrics.test.ts) can exercise, since
// the SQL is the product here (D373's engine-specific combinator pairing,
// D374's series-key grouping, D375's mapUpdate merge). Seeding writes RAW
// rows straight into `metric_points`: the MVs fire synchronously on INSERT
// (measured against the pinned engine — no receiver dependency, per this
// task's plan note), so this proves the query layer without T4's wiring.
//
// Skips only when no ClickHouse answers; `web.yml`'s D36 skip trap fails the
// job on an unexpected skip, so this file executes on every PR.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = WEB_USER;
process.env.CLICKHOUSE_PASSWORD = WEB_PASSWORD;

const seed = createClient({
  url: CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: INGEST_PASSWORD,
  database: "obstack",
});

async function clickhouseReachable(): Promise<boolean> {
  try {
    return (await seed.ping()).success;
  } catch {
    return false;
  }
}

/**
 * Two workspaces of this run's own, never the compose dev default `ws_demo`
 * (traces.integration.test.ts precedent) — the seeding user has no mutation
 * grant, so nothing here can be cleaned up afterwards. `WORKSPACE_B` is the
 * second tenant the cross-tenant probe at the bottom needs.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;

const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` — mirrors traces.integration.test.ts's `chTimestamp`. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

/** A raw `metric_points` row with the house defaults for the columns a given probe does not care about. */
function point(overrides: {
  workspace_id: string;
  name: string;
  type: "gauge" | "sum" | "histogram";
  series_hash: number;
  timestamp: string;
  value?: number;
  bounds?: number[];
  bucket_counts?: number[];
  h_sum?: number;
  h_count?: number;
  h_min?: number;
  h_max?: number;
  attributes?: Record<string, string>;
  resource_attributes?: Record<string, string>;
}) {
  return {
    unit: "1",
    service: "metrics-it",
    value: 0,
    is_monotonic: 0,
    bounds: [],
    bucket_counts: [],
    h_sum: 0,
    h_count: 0,
    h_min: 0,
    h_max: 0,
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

test("catalog + gauge series (D363 §0) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { listMetricCatalog, queryMetricSeries } = await import("./metrics");
  const ch = forWorkspace(WORKSPACE_ID);

  const suffix = randomBytes(6).toString("hex");
  const metric = `it.gauge.${suffix}`;
  // Both points anchored a couple of seconds into the SAME floored 1-minute
  // bucket — the query's own bucket boundaries are epoch-aligned
  // (`floor(epochSeconds / 60) * 60`), so this is deterministic regardless of
  // which second-of-the-minute the test happens to run at (a fixed "N seconds
  // ago" offset is not: it can straddle a minute boundary depending on when
  // the clock reads `now`, which is exactly the flake this anchor avoids).
  const bucketStartS = Math.floor(Date.now() / 1000 / 60) * 60;
  const t1 = BigInt(bucketStartS) * NS_PER_SECOND + NS_PER_SECOND; // :01
  const t2 = BigInt(bucketStartS) * NS_PER_SECOND + BigInt(2) * NS_PER_SECOND; // :02

  await seed.insert({
    table: "metric_points",
    format: "JSONEachRow",
    values: [
      point({
        workspace_id: WORKSPACE_ID,
        name: metric,
        type: "gauge",
        series_hash: 1,
        timestamp: chTimestamp(t1),
        value: 10,
        attributes: { route: "/a" },
        // D375: resource-borne keys land in the merged attributes map too —
        // this is what makes k8s.pod.name usable as a groupBy/filter key.
        resource_attributes: { "k8s.pod.name": "pod-x" },
      }),
      point({
        workspace_id: WORKSPACE_ID,
        name: metric,
        type: "gauge",
        series_hash: 1,
        timestamp: chTimestamp(t2),
        value: 20,
        attributes: { route: "/a" },
        resource_attributes: { "k8s.pod.name": "pod-x" },
      }),
    ],
  });

  await t.test("listMetricCatalog discovers the metric with its merged attribute keys", async () => {
    const catalog = await listMetricCatalog(ch);
    const entry = catalog.find((e) => e.name === metric);
    assert.ok(entry, "the seeded metric did not appear in the catalog");
    assert.equal(entry!.type, "gauge");
    assert.equal(entry!.unit, "1");
    assert.deepEqual(
      [...entry!.attrKeys].sort(),
      ["k8s.pod.name", "route"],
      "resource-borne attributes must be merged into the catalog's attrKeys (D375)",
    );
    // "ISO UTC minute" (D363 §0) is formatted by the ENGINE — this is the only
    // place that proves the format string against a real DateTime('UTC').
    assert.match(entry!.lastSeen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  });

  await t.test("queryMetricSeries: avg/min/max/last read real merged rollup rows, current bucket populated", async () => {
    for (const [agg, expected] of [
      ["avg", 15],
      ["min", 10],
      ["max", 20],
      ["last", 20],
    ] as const) {
      const {
        series: [series],
      } = await queryMetricSeries(ch, {
        metric,
        range: "1h",
        agg,
        groupBy: null,
        filters: {},
      });
      assert.ok(series, `${agg}: no series returned`);
      assert.equal(series.points.length, 60);
      const nonNull = series.points.filter((p) => p.v !== null);
      assert.ok(nonNull.length > 0, `${agg}: every bucket was null — the rollup read found nothing`);
      assert.equal(
        nonNull[nonNull.length - 1].v,
        expected,
        `${agg}: unexpected value in the most recent populated bucket`,
      );
    }
  });

  await t.test("queryMetricSeries: an invalid agg for a gauge is a request error against real data too", async () => {
    await assert.rejects(
      queryMetricSeries(ch, { metric, range: "1h", agg: "sum", groupBy: null, filters: {} }),
      /invalid aggregation "sum"/,
    );
  });

  await t.test("queryMetricSeries: filters narrow to the matching series only (control: an unfiltered read still finds it)", async () => {
    const {
      series: [filtered],
    } = await queryMetricSeries(ch, {
      metric,
      range: "1h",
      agg: "last",
      groupBy: null,
      filters: { route: "/does-not-exist" },
    });
    assert.ok(
      filtered.points.every((p) => p.v === null),
      "a filter value matching no series must not leak the unfiltered data",
    );
    const {
      series: [control],
    } = await queryMetricSeries(ch, {
      metric,
      range: "1h",
      agg: "last",
      groupBy: null,
      filters: { route: "/a" },
    });
    assert.ok(control.points.some((p) => p.v !== null), "the matching filter value found nothing — the fixture is broken");
  });
});

test("queryMetricSeries: groupBy on a resource-borne key, top-10 ranking (D375/D363 §0) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { queryMetricSeries } = await import("./metrics");
  const ch = forWorkspace(WORKSPACE_ID);

  const suffix = randomBytes(6).toString("hex");
  const metric = `it.grouped.${suffix}`;
  const now = BigInt(Date.now()) * NS_PER_MS;

  // Two pods (resource-borne groupBy key), one with twice the sample count —
  // point count ranking must put it first.
  const values: ReturnType<typeof point>[] = [];
  for (let i = 0; i < 4; i++) {
    values.push(
      point({
        workspace_id: WORKSPACE_ID,
        name: metric,
        type: "gauge",
        series_hash: 10 + i,
        timestamp: chTimestamp(now - BigInt(i) * BigInt(30) * NS_PER_SECOND),
        value: 1,
        attributes: {},
        resource_attributes: { "k8s.pod.name": "busy-pod" },
      }),
    );
  }
  values.push(
    point({
      workspace_id: WORKSPACE_ID,
      name: metric,
      type: "gauge",
      series_hash: 20,
      timestamp: chTimestamp(now),
      value: 1,
      attributes: {},
      resource_attributes: { "k8s.pod.name": "quiet-pod" },
    }),
  );
  // A series carrying NO k8s.pod.name at all — must be excluded from a
  // groupBy=k8s.pod.name read (mapContains gate), never surfaced as an
  // empty-string group.
  values.push(
    point({
      workspace_id: WORKSPACE_ID,
      name: metric,
      type: "gauge",
      series_hash: 30,
      timestamp: chTimestamp(now),
      value: 999,
      attributes: {},
      resource_attributes: {},
    }),
  );

  await seed.insert({ table: "metric_points", format: "JSONEachRow", values });

  const { series: groups, totalGroups } = await queryMetricSeries(ch, {
    metric,
    range: "1h",
    agg: "last",
    groupBy: "k8s.pod.name",
    filters: {},
  });

  const groupNames = groups.map((g) => g.group);
  assert.deepEqual(
    groupNames,
    ["busy-pod", "quiet-pod"],
    "busy-pod (more points) must rank first; the pod-less series must never appear as a group",
  );
  // D381: only 2 real groups exist here (well under the top-10 cap), so
  // totalGroups must equal the untruncated series length exactly.
  assert.equal(totalGroups, 2, "totalGroups must count the real (pod-less-excluded) groups, pre-truncation");
});

// The sum and histogram temperaments read columns the gauge probes above never
// touch, and each carries a DIFFERENT combinator pairing (D363 §3): `sum_delta`
// and `h_sum`/`h_count` are SimpleAggregateFunction columns that take a PLAIN
// `sum`, while `hist_counts` is an AggregateFunction(sumForEach) that needs
// `-Merge`. A mixup there reads garbage silently rather than failing, so it is
// proven here against real merged rows, not reasoned about.
test("sum + histogram temperaments against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { queryMetricSeries } = await import("./metrics");
  const ch = forWorkspace(WORKSPACE_ID);

  const suffix = randomBytes(6).toString("hex");
  const sumMetric = `it.sum.${suffix}`;
  const histMetric = `it.hist.${suffix}`;
  const bucketStartS = Math.floor(Date.now() / 1000 / 60) * 60;
  const at = (second: number) => chTimestamp(BigInt(bucketStartS + second) * NS_PER_SECOND);

  // Two deltas of 30 in ONE 1-minute bucket: sum = 60, rate = 60/60s = 1.
  // The histogram halves merge to the unit test's known distribution
  // (bounds [0,10,20,30,40], counts [0,10,10,10,10,0]): p50 = 20, p90 = 36,
  // and h_sum/h_count = 800/40 -> avg 20.
  await seed.insert({
    table: "metric_points",
    format: "JSONEachRow",
    values: [
      point({ workspace_id: WORKSPACE_ID, name: sumMetric, type: "sum", series_hash: 50, timestamp: at(1), value: 30 }),
      point({ workspace_id: WORKSPACE_ID, name: sumMetric, type: "sum", series_hash: 50, timestamp: at(2), value: 30 }),
      point({
        workspace_id: WORKSPACE_ID,
        name: histMetric,
        type: "histogram",
        series_hash: 60,
        timestamp: at(1),
        bounds: [0, 10, 20, 30, 40],
        bucket_counts: [0, 5, 5, 0, 0, 0],
        h_sum: 100,
        h_count: 10,
      }),
      point({
        workspace_id: WORKSPACE_ID,
        name: histMetric,
        type: "histogram",
        series_hash: 60,
        timestamp: at(2),
        bounds: [0, 10, 20, 30, 40],
        bucket_counts: [0, 5, 5, 10, 10, 0],
        h_sum: 700,
        h_count: 30,
      }),
    ],
  });

  const latest = async (metric: string, agg: "sum" | "rate" | "avg" | "p50" | "p90") => {
    const {
      series: [series],
    } = await queryMetricSeries(ch, { metric, range: "1h", agg, groupBy: null, filters: {} });
    assert.ok(series, `${metric}/${agg}: no series returned`);
    const nonNull = series.points.filter((p) => p.v !== null);
    assert.ok(nonNull.length > 0, `${metric}/${agg}: every bucket was null — the rollup read found nothing`);
    return nonNull[nonNull.length - 1].v;
  };

  await t.test("a sum reads its delta, and rate divides it by the bucket's seconds", async () => {
    assert.equal(await latest(sumMetric, "sum"), 60);
    assert.equal(await latest(sumMetric, "rate"), 1);
  });

  await t.test("histogram quantiles come off the MERGED bucket arrays, avg off h_sum/h_count", async () => {
    assert.equal(await latest(histMetric, "p50"), 20);
    assert.equal(await latest(histMetric, "p90"), 36);
    assert.equal(await latest(histMetric, "avg"), 20);
  });

  await t.test("an agg invalid for the observed type is refused for each temperament", async () => {
    await assert.rejects(
      queryMetricSeries(ch, { metric: sumMetric, range: "1h", agg: "p95", groupBy: null, filters: {} }),
      /invalid aggregation "p95"/,
    );
    await assert.rejects(
      queryMetricSeries(ch, { metric: histMetric, range: "1h", agg: "last", groupBy: null, filters: {} }),
      /invalid aggregation "last"/,
    );
  });
});

// T4 (D96/D113): the leak class this sprint's read layer must not reintroduce
// — two tenants holding rows under the SAME metric name, in the SAME tables.
test("cross-tenant disjointness (D96) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { listMetricCatalog, queryMetricSeries } = await import("./metrics");

  const suffix = randomBytes(6).toString("hex");
  const metric = `it.tenant.${suffix}`;
  const now = BigInt(Date.now()) * NS_PER_MS;

  await seed.insert({
    table: "metric_points",
    format: "JSONEachRow",
    values: [
      point({
        workspace_id: WORKSPACE_ID,
        name: metric,
        type: "gauge",
        series_hash: 40,
        timestamp: chTimestamp(now),
        value: 111,
      }),
      point({
        workspace_id: WORKSPACE_B,
        name: metric,
        type: "gauge",
        series_hash: 41,
        timestamp: chTimestamp(now),
        value: 222,
      }),
    ],
  });

  const a = forWorkspace(WORKSPACE_ID);
  const b = forWorkspace(WORKSPACE_B);

  await t.test("the catalog never crosses tenants (control: each sees its own)", async () => {
    const catalogA = await listMetricCatalog(a);
    const catalogB = await listMetricCatalog(b);
    assert.ok(catalogA.some((e) => e.name === metric), "workspace A cannot see its own metric");
    assert.ok(catalogB.some((e) => e.name === metric), "workspace B cannot see its own metric");
  });

  await t.test("a series query never returns another tenant's values", async () => {
    const {
      series: [seriesA],
    } = await queryMetricSeries(a, { metric, range: "1h", agg: "last", groupBy: null, filters: {} });
    const {
      series: [seriesB],
    } = await queryMetricSeries(b, { metric, range: "1h", agg: "last", groupBy: null, filters: {} });
    const lastA = seriesA.points.filter((p) => p.v !== null).at(-1)?.v;
    const lastB = seriesB.points.filter((p) => p.v !== null).at(-1)?.v;
    assert.equal(lastA, 111, "workspace A read a value that is not its own");
    assert.equal(lastB, 222, "workspace B read a value that is not its own");
  });
});
