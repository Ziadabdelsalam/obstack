import assert from "node:assert/strict";
import test from "node:test";
import { COSTS_GROUP_CAP, DEFAULT_COSTS_RANGE, type CostsRange } from "@/lib/costs-types";
import { forWorkspace } from "@/server/clickhouse";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { parseCostsRange, queryCosts } from "./costs";

// run with: npm test --workspace apps/web -- costs
//
// Hermetic (D96/D113), like services.test.ts: nothing here needs a live
// ClickHouse. The seeded-server half of the D460/D461 contract — the numbers
// the SQL actually computes, and the tenancy fence around them — lives in
// costs.integration.test.ts.

// ---- unscoped-SQL tripwire, proven red for the one table this module reads --

test("tripwire: a bare SELECT against obstack.spans is refused before any query runs", async () => {
  const ch = forWorkspace("ws_costs_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT sum(cost_usd) FROM obstack.spans WHERE layer = 'llm'"),
    /refusing unscoped SQL/,
  );
});

test("tripwire: a caller that supplies its own workspace_id is refused (D113)", async () => {
  const ch = forWorkspace("ws_costs_tripwire");
  await assert.rejects(
    ch.queryRows("SELECT sum(cost_usd) FROM obstack.spans WHERE workspace_id = {workspace_id:String}", {
      workspace_id: "ws_someone_else",
    }),
    /refusing a caller-supplied workspace_id/,
  );
});

// ---- what the query layer sends (D113: no query names a workspace) --------

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

/** Every statement, no exceptions: the scope's placeholder, the layer fence, no FINAL, no workspace of its own. */
function assertEveryCallScopedToLlm(label: string, calls: Call[]): void {
  assert.ok(calls.length > 0, `${label} issued no statements`);
  for (const call of calls) {
    const first = call.sql.trim().split("\n")[0];
    assert.ok(call.sql.includes("{workspace_id:"), `${label} sent a statement with no workspace placeholder: ${first}`);
    assert.ok(
      !("workspace_id" in call.params),
      `${label} bound a workspace_id of its own — the scope is the only thing allowed to (D113)`,
    );
    assert.ok(
      call.sql.includes("layer = 'llm'"),
      `${label} sent a statement that is not fenced to the llm layer (D461): ${first}`,
    );
    assert.ok(
      !call.sql.includes("FINAL"),
      `${label} used FINAL — the D7 house rule is GROUP BY plus the matching combinator`,
    );
  }
}

const MODEL_IDENTITY = "if(gen_ai_response_model != '', gen_ai_response_model, gen_ai_request_model)";
const UNPRICED = "input_tokens + output_tokens > 0 AND cost_usd = 0";

const byModel = (sql: string): boolean => sql.includes("total_models");
const byService = (sql: string): boolean => sql.includes("total_services");
const unpriced = (sql: string): boolean => sql.includes("total_unpriced_models");
const isSeries = (sql: string): boolean => sql.includes("bucket_epoch_s");

/** The totals ride every model row (one grouped set, one answer) — so both rows carry them. */
const ALL_TOTALS = {
  total_models: "11",
  all_cost_usd: 1.5,
  all_input_tokens: "1012",
  all_output_tokens: "203",
  all_calls: "12",
  all_unpriced_calls: "2",
};

const MODEL_ROWS = [
  {
    model: "gpt-4o",
    system: "openai",
    cost_usd: 1.5,
    input_tokens: "1000",
    output_tokens: "200",
    calls: "10",
    unpriced_calls: "0",
    ...ALL_TOTALS,
  },
  {
    // Priced at 0 with tokens spent: the honesty case (D461).
    model: "acme-ft",
    system: "custom",
    cost_usd: 0,
    input_tokens: "12",
    output_tokens: "3",
    calls: "2",
    unpriced_calls: "2",
    ...ALL_TOTALS,
  },
];

const SERVICE_ROWS = [
  {
    service: "agent",
    cost_usd: 1.5,
    calls: "10",
    unpriced_calls: "0",
    model_count: "3",
    total_services: "4",
  },
];

const UNPRICED_ROWS = [{ model: "acme-ft", calls: "2", total_unpriced_models: "7" }];

/** The current bucket's epoch second for a bucket width — the grid's own flooring. */
const flooredNow = (bucketMinutes: number): number =>
  Math.floor(Date.now() / 1000 / (bucketMinutes * 60)) * (bucketMinutes * 60);

/**
 * The grid is measured from `Date.now()`, so the D472 point counts are only
 * assertable against a clock this test owns (`metrics.test.ts`'s `withFixedNow`).
 */
async function withFixedNow<T>(iso: string, run: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return await run();
  } finally {
    Date.now = real;
  }
}

/** Mid-bucket for all three widths: both ends of every grid are partial. */
const NOW_OFF_BOUNDARY = "2026-09-01T10:30:00.000Z";
/** Midnight UTC is a boundary for 1h, 6h AND 1d, so no bucket is clipped at either end. */
const NOW_ON_BOUNDARY = "2026-09-01T00:00:00.000Z";

function respond(sql: string): unknown[] {
  if (unpriced(sql)) return UNPRICED_ROWS;
  if (byModel(sql)) return MODEL_ROWS;
  if (byService(sql)) return SERVICE_ROWS;
  if (isSeries(sql)) return [{ bucket_epoch_s: flooredNow(60), cost_usd: 0.75, calls: "3" }];
  throw new Error(`unexpected statement: ${sql.trim().split("\n")[0]}`);
}

test("queryCosts: four scoped reads over spans, every one of them fenced to layer 'llm'", async () => {
  const { ch, calls } = recorder(respond);

  await queryCosts(ch, "24h");

  assert.equal(calls.length, 4, "by model, by service, the unpriced list, and the series");
  assertEveryCallScopedToLlm("queryCosts", calls);
  for (const call of calls) {
    assert.ok(call.sql.includes("obstack.spans"), "per-model cost exists in spans and nowhere else (D395)");
    assert.ok(
      call.sql.includes("start_time >= now() - toIntervalHour({window_hours:UInt32})"),
      "the window is bound, never spelled out (D11)",
    );
  }
});

test("queryCosts: the model identity is response-model-first, on every grouped read", async () => {
  const { ch, calls } = recorder(respond);
  await queryCosts(ch, "24h");
  for (const call of calls.filter((c) => !isSeries(c.sql))) {
    assert.ok(
      call.sql.includes(MODEL_IDENTITY),
      `a grouped read named a model some other way: ${call.sql.trim().split("\n")[0]}`,
    );
  }
});

test("queryCosts: the unpriced predicate is ONE text — counted per group, and the list's own WHERE", async () => {
  const { ch, calls } = recorder(respond);
  await queryCosts(ch, "24h");

  const model = calls.find((c) => byModel(c.sql));
  const service = calls.find((c) => byService(c.sql));
  const list = calls.find((c) => unpriced(c.sql));
  assert.ok(model?.sql.includes(`countIf(${UNPRICED})`), "byModel does not count unpriced calls");
  assert.ok(service?.sql.includes(`countIf(${UNPRICED})`), "byService does not count unpriced calls");
  assert.ok(list?.sql.includes(`AND ${UNPRICED}`), "the unpriced list is not filtered by the predicate");
  // The series is spend over time only — an unpriced call has no spend to plot,
  // and its honesty lives in the totals and the list above.
  const series = calls.find((c) => isSeries(c.sql));
  assert.equal(series?.sql.includes(UNPRICED), false);
});

test("queryCosts: each grouped list is capped by a BOUND parameter with its pre-truncation total (D402)", async () => {
  const { ch, calls } = recorder(respond);
  const report = await queryCosts(ch, "24h");

  for (const call of calls.filter((c) => !isSeries(c.sql))) {
    assert.equal(call.params.cap, COSTS_GROUP_CAP, "the cap is bound, never spliced (D11)");
    assert.ok(call.sql.includes("LIMIT {cap:UInt32}"));
    assert.ok(call.sql.includes("count() OVER ()"), "the total must come from the same grouped set as the rows");
  }
  assert.equal(COSTS_GROUP_CAP, 10);
  assert.equal(report.totalModels, 11, "the pre-cap count, not the page length");
  assert.equal(report.totalServices, 4);
  assert.equal(report.totalUnpricedModels, 7);
  // The series is a fixed grid, not a top-N: nothing to cap.
  const series = calls.find((c) => isSeries(c.sql));
  assert.equal("cap" in (series?.params ?? {}), false);
});

test("queryCosts: byModel ranks spend then volume; the unpriced list ranks volume (D461)", async () => {
  const { ch, calls } = recorder(respond);
  await queryCosts(ch, "24h");

  assert.ok(calls.find((c) => byModel(c.sql))?.sql.includes("ORDER BY cost DESC, n_calls DESC, model"));
  assert.ok(calls.find((c) => byService(c.sql))?.sql.includes("ORDER BY cost DESC, n_calls DESC, service"));
  // Cost-ranked, an unpriced model (cost 0) never places — so it gets a list of
  // its own, ranked by the only number it has.
  assert.ok(calls.find((c) => unpriced(c.sql))?.sql.includes("ORDER BY n_calls DESC, model"));
  assert.ok(
    calls.find((c) => byService(c.sql))?.sql.includes(`uniqExact(${MODEL_IDENTITY})`),
    "a service's model count is a distinct count, not an array of names",
  );
});

test("queryCosts: every row is mapped exactly, and the totals come off the same grouped set", async () => {
  const { ch } = recorder(respond);
  const report = await queryCosts(ch, "24h");

  assert.equal(report.range, "24h");
  assert.deepEqual(report.byModel, [
    {
      model: "gpt-4o",
      system: "openai",
      costUsd: 1.5,
      inputTokens: 1000,
      outputTokens: 200,
      calls: 10,
      unpricedCalls: 0,
    },
    {
      model: "acme-ft",
      system: "custom",
      costUsd: 0,
      inputTokens: 12,
      outputTokens: 3,
      calls: 2,
      unpricedCalls: 2,
    },
  ]);
  assert.deepEqual(report.byService, [
    { service: "agent", costUsd: 1.5, calls: 10, unpricedCalls: 0, modelCount: 3 },
  ]);
  assert.deepEqual(report.unpricedModels, [{ model: "acme-ft", calls: 2 }]);
  assert.deepEqual(report.totals, {
    costUsd: 1.5,
    inputTokens: 1012,
    outputTokens: 203,
    // 12 calls, 2 of which bought tokens nobody could price: the page says so
    // rather than adding $0.00 to the bill.
    calls: 12,
    unpricedCalls: 2,
  });
});

test("queryCosts: no rows is no calls — zeroed totals, empty lists, and a chart that still has a grid", async () => {
  const { ch } = recorder(() => []);
  const report = await withFixedNow(NOW_OFF_BOUNDARY, () => queryCosts(ch, "24h"));

  assert.deepEqual(report.totals, {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    unpricedCalls: 0,
  });
  assert.deepEqual(report.byModel, []);
  assert.deepEqual(report.byService, []);
  assert.deepEqual(report.unpricedModels, []);
  assert.equal(report.totalModels, 0);
  assert.equal(report.totalServices, 0);
  assert.equal(report.totalUnpricedModels, 0);
  assert.equal(report.series.length, 25);
  assert.deepEqual(
    report.series.map((p) => p.costUsd + p.calls),
    Array.from({ length: 25 }, () => 0),
  );
});

// ---- the ruled range → bucket map, and the D472 window the grid covers ----
//
// The grid covers EXACTLY the rolling window the totals do, so both of its ends
// are partial: the first slot starts at `now - N hours` (not at a boundary) and
// the last is the bucket now filling. That makes the point count a function of
// where `now` falls, which is why both cases are pinned against a frozen clock.

const GRID: Record<CostsRange, { windowHours: number; bucketMinutes: number }> = {
  "24h": { windowHours: 24, bucketMinutes: 60 },
  "7d": { windowHours: 168, bucketMinutes: 360 },
  "30d": { windowHours: 720, bucketMinutes: 1440 },
};

/** Whole buckets in the window + the leading clipped slot + the trailing partial one. */
const GRID_CASES: {
  now: string;
  range: CostsRange;
  points: number;
  first: string;
  second: string;
  last: string;
}[] = [
  {
    now: NOW_OFF_BOUNDARY,
    range: "24h",
    points: 25,
    first: "2026-08-31T10:30:00.000Z",
    second: "2026-08-31T11:00:00.000Z",
    last: "2026-09-01T10:00:00.000Z",
  },
  {
    now: NOW_OFF_BOUNDARY,
    range: "7d",
    points: 29,
    first: "2026-08-25T10:30:00.000Z",
    second: "2026-08-25T12:00:00.000Z",
    last: "2026-09-01T06:00:00.000Z",
  },
  {
    now: NOW_OFF_BOUNDARY,
    range: "30d",
    points: 31,
    first: "2026-08-02T10:30:00.000Z",
    second: "2026-08-03T00:00:00.000Z",
    last: "2026-09-01T00:00:00.000Z",
  },
  // A window start that lands ON a boundary clips nothing, so the grid is one
  // point shorter: the bucket beginning at `now` has had no time to fill.
  {
    now: NOW_ON_BOUNDARY,
    range: "24h",
    points: 24,
    first: "2026-08-31T00:00:00.000Z",
    second: "2026-08-31T01:00:00.000Z",
    last: "2026-08-31T23:00:00.000Z",
  },
  {
    now: NOW_ON_BOUNDARY,
    range: "7d",
    points: 28,
    first: "2026-08-25T00:00:00.000Z",
    second: "2026-08-25T06:00:00.000Z",
    last: "2026-08-31T18:00:00.000Z",
  },
  {
    now: NOW_ON_BOUNDARY,
    range: "30d",
    points: 30,
    first: "2026-08-02T00:00:00.000Z",
    second: "2026-08-03T00:00:00.000Z",
    last: "2026-08-31T00:00:00.000Z",
  },
];

for (const { now, range, points, first, second, last } of GRID_CASES) {
  const { windowHours, bucketMinutes } = GRID[range];
  test(`queryCosts(${range}) at ${now}: ${windowHours}h of ${bucketMinutes}-minute buckets, ${points} points`, async () => {
    const { ch, calls } = recorder(() => []);
    const report = await withFixedNow(now, () => queryCosts(ch, range));

    for (const call of calls) {
      assert.equal(call.params.window_hours, windowHours, "every read covers the same window");
    }
    const series = calls.find((c) => isSeries(c.sql));
    assert.equal(series?.params.bucket_minutes, bucketMinutes);
    assert.ok(
      series?.sql.includes("INTERVAL {bucket_minutes:UInt32} MINUTE"),
      "the bucket width is bound, never spliced (D11)",
    );

    assert.equal(report.series.length, points);
    // The chart starts where the window starts (D472) — the first slot is the
    // window's own start, not the boundary the SQL keyed its bucket at.
    assert.equal(report.series[0].t, first);
    assert.equal(Date.parse(first), Date.parse(now) - windowHours * 3_600_000);
    assert.equal(report.series[1].t, second);
    assert.equal(report.series[points - 1].t, last);
    // ...and it ends inside the bucket that is filling right now.
    assert.ok(Date.parse(last) <= Date.parse(now));
    assert.ok(Date.parse(last) + bucketMinutes * 60_000 >= Date.parse(now));

    const ts = report.series.map((p) => Date.parse(p.t));
    assert.ok(
      ts.slice(1).every((t) => t % (bucketMinutes * 60_000) === 0),
      "every slot after the clipped first one starts on an epoch-floored boundary",
    );
    assert.ok(
      ts.every((t, i) => i < 2 || t - ts[i - 1] === bucketMinutes * 60_000),
      "the grid is evenly spaced, with no bucket missing",
    );
    assert.ok(ts[1] - ts[0] <= bucketMinutes * 60_000, "the first slot is a clipped bucket, never a longer one");
  });
}

test("queryCosts: every returned bucket lands on a slot — the bars sum to the totals (D472)", async () => {
  const bucket = (iso: string): number => Date.parse(iso) / 1000;
  const rows = [
    // The window opens at 10:30 inside this bucket; the WHERE has already
    // clipped it, so all of it belongs to the leading slot.
    { bucket_epoch_s: bucket("2026-08-31T10:00:00.000Z"), cost_usd: 0.5, calls: "2" },
    { bucket_epoch_s: bucket("2026-09-01T09:00:00.000Z"), cost_usd: 0.25, calls: "1" },
    // The bucket now filling.
    { bucket_epoch_s: bucket("2026-09-01T10:00:00.000Z"), cost_usd: 0.125, calls: "4" },
  ];
  const { ch } = recorder((sql) => (isSeries(sql) ? rows : []));
  const report = await withFixedNow(NOW_OFF_BOUNDARY, () => queryCosts(ch, "24h"));

  assert.deepEqual(report.series[0], { t: "2026-08-31T10:30:00.000Z", costUsd: 0.5, calls: 2 });
  assert.deepEqual(report.series[23], { t: "2026-09-01T09:00:00.000Z", costUsd: 0.25, calls: 1 });
  assert.deepEqual(report.series[24], { t: "2026-09-01T10:00:00.000Z", costUsd: 0.125, calls: 4 });
  // No calls IS no cost (D460) — an empty hour is 0, not a gap and not a null.
  assert.deepEqual(report.series[1], { t: "2026-08-31T11:00:00.000Z", costUsd: 0, calls: 0 });
  assert.equal(
    report.series.reduce((sum, p) => sum + p.costUsd, 0),
    0.875,
    "every returned bucket is drawn somewhere, so the bars sum to the headline",
  );
  assert.equal(report.series.reduce((sum, p) => sum + p.calls, 0), 7);
});

test("queryCosts: a bucket keyed outside the grid is folded into the nearest end, never dropped", async () => {
  // Four statements, four server-side `now()`s: a row can be keyed one bucket
  // below the grid this process measured. It is still money the totals counted.
  const rows = [
    { bucket_epoch_s: Date.parse("2026-08-31T09:00:00.000Z") / 1000, cost_usd: 0.25, calls: "1" },
    { bucket_epoch_s: Date.parse("2026-09-01T11:00:00.000Z") / 1000, cost_usd: 0.5, calls: "2" },
  ];
  const { ch } = recorder((sql) => (isSeries(sql) ? rows : []));
  const report = await withFixedNow(NOW_OFF_BOUNDARY, () => queryCosts(ch, "24h"));

  assert.equal(report.series[0].calls, 1);
  assert.equal(report.series[24].calls, 2);
  assert.equal(report.series.reduce((sum, p) => sum + p.costUsd, 0), 0.75);
});

// ---- parseCostsRange (D462: invalid ⇒ the default, never a throw) ---------

test("parseCostsRange: the three ranges pass through; everything else is the default", () => {
  assert.equal(DEFAULT_COSTS_RANGE, "24h");
  const table: [string | undefined, CostsRange][] = [
    ["24h", "24h"],
    ["7d", "7d"],
    ["30d", "30d"],
    // Not a case-insensitive parse — an unknown string is the default, and
    // "24H" is an unknown string.
    ["24H", "24h"],
    ["1h", "24h"],
    ["", "24h"],
    ["7d; DROP", "24h"],
    ["__proto__", "24h"],
    [undefined, "24h"],
  ];
  for (const [raw, expected] of table) {
    assert.equal(parseCostsRange(raw), expected, `parseCostsRange(${JSON.stringify(raw)})`);
  }
});
