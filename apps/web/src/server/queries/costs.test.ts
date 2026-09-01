import assert from "node:assert/strict";
import test from "node:test";
import { COSTS_GROUP_CAP, COSTS_RANGES, DEFAULT_COSTS_RANGE, type CostsRange } from "@/lib/costs-types";
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
  const report = await queryCosts(ch, "24h");

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
  assert.equal(report.series.length, 24);
  assert.deepEqual(
    report.series.map((p) => p.costUsd + p.calls),
    Array.from({ length: 24 }, () => 0),
  );
});

// ---- the ruled range → bucket map (D462) ----------------------------------

const GRID: Record<CostsRange, { windowHours: number; bucketMinutes: number; points: number }> = {
  "24h": { windowHours: 24, bucketMinutes: 60, points: 24 },
  "7d": { windowHours: 168, bucketMinutes: 360, points: 28 },
  "30d": { windowHours: 720, bucketMinutes: 1440, points: 30 },
};

for (const range of COSTS_RANGES) {
  const { windowHours, bucketMinutes, points } = GRID[range];
  test(`queryCosts(${range}): ${windowHours}h of ${bucketMinutes}-minute buckets, ${points} points`, async () => {
    const { ch, calls } = recorder((sql) => (isSeries(sql) ? [] : []));
    const report = await queryCosts(ch, range);

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
    assert.equal(points * bucketMinutes * 60, windowHours * 3600, "the grid must span exactly the window it names");

    const ts = report.series.map((p) => Date.parse(p.t));
    assert.ok(
      ts.every((t, i) => i === 0 || t - ts[i - 1] === bucketMinutes * 60_000),
      "the grid is evenly spaced, with no bucket missing",
    );
    assert.ok(ts.every((t) => t % (bucketMinutes * 60_000) === 0), "every bucket starts on an epoch-floored boundary");
    assert.equal(report.series[points - 1].t, new Date(flooredNow(bucketMinutes) * 1000).toISOString());
  });
}

test("queryCosts: a bucket the SQL returned lands on its grid slot; the rest are 0 calls, 0 cost", async () => {
  const bucket = flooredNow(60);
  const { ch } = recorder((sql) =>
    isSeries(sql) ? [{ bucket_epoch_s: bucket - 3600, cost_usd: 0.75, calls: "3" }] : [],
  );
  const report = await queryCosts(ch, "24h");

  const point = report.series[report.series.length - 2];
  assert.equal(point.t, new Date((bucket - 3600) * 1000).toISOString());
  assert.deepEqual(point, { t: point.t, costUsd: 0.75, calls: 3 });
  // No calls IS no cost (D460) — an empty hour is 0, not a gap and not a null.
  assert.deepEqual(report.series[0], { t: report.series[0].t, costUsd: 0, calls: 0 });
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
