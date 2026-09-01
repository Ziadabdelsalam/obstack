import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { COSTS_GROUP_CAP } from "@/lib/costs-types";
import { forWorkspace } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of the D460/D461 contract: the numbers themselves.
// `costs.test.ts` proves what the module SENDS; only a real server proves what
// the statements COMPUTE — the layer fence, the response-model-first identity,
// the unpriced predicate against a row that really does carry tokens and no
// price, the D402 cap with its pre-truncation total, and the tenancy scope
// under a second workspace using the SAME model and service names.
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
 * Three workspaces of this run's own, never the compose dev default `ws_demo`
 * (traces.integration.test.ts precedent): the seeding user has no mutation
 * grant, so nothing here can be cleaned up afterwards. `WORKSPACE_B` carries
 * the SAME model and service NAMES as A with different money, which is the only
 * fixture that can tell a scoped read from an unscoped one; `WORKSPACE_CAP`
 * exists so the D402 cap can be proven against a set larger than it.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;
const WORKSPACE_CAP = `ws_itc_${randomBytes(4).toString("hex")}`;
/** D472: one call 10 minutes inside each range's far edge, one 30 minutes old. */
const WORKSPACE_EDGE = `ws_ite_${randomBytes(4).toString("hex")}`;

const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` — traces.integration.test.ts's `chTimestamp`. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

const NOW_NS = BigInt(Date.now()) * NS_PER_MS;
const hoursAgo = (h: number): bigint => NOW_NS - BigInt(Math.round(h * 3_600_000)) * NS_PER_MS;
const minutesAgo = (m: number): bigint => NOW_NS - BigInt(Math.round(m * 60_000)) * NS_PER_MS;

function spanRow(overrides: {
  span_id: string;
  start_time: string;
  service: string;
  workspace_id?: string;
  trace_id?: string;
  layer?: string;
  gen_ai_system?: string;
  gen_ai_request_model?: string;
  gen_ai_response_model?: string;
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    trace_id: randomBytes(16).toString("hex"),
    parent_span_id: "",
    name: "chat.completion",
    kind: "client",
    status_code: "ok",
    status_message: "",
    layer: "llm",
    gen_ai_system: "openai",
    gen_ai_request_model: "",
    gen_ai_response_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    finish_reason: "stop",
    prompt: "",
    completion: "",
    duration_ns: "1000000",
    k8s_namespace: "",
    k8s_pod: "",
    k8s_container: "",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

/**
 * Every dollar figure is a binary-exact fraction, so `sum(cost_usd)` and the
 * assertions below are the same number rather than the same number ± a float
 * epsilon — the point of the test is the SQL, not IEEE 754.
 *
 * The window's four LLM calls: two of one model (asked for by a dated name and
 * answered by the bare one), one priced call of a second model, and one call
 * that spent 15 tokens and was charged nothing — D461's whole subject.
 */
const WORKSPACE_A_SPANS = [
  spanRow({
    span_id: "a1",
    service: "agent",
    start_time: chTimestamp(hoursAgo(1)),
    gen_ai_request_model: "gpt-4o-2024-08",
    gen_ai_response_model: "gpt-4o",
    input_tokens: 100,
    output_tokens: 20,
    cost_usd: 0.5,
  }),
  spanRow({
    span_id: "a2",
    service: "agent",
    start_time: chTimestamp(hoursAgo(2)),
    gen_ai_request_model: "gpt-4o-2024-08",
    gen_ai_response_model: "gpt-4o",
    input_tokens: 50,
    output_tokens: 10,
    cost_usd: 0.25,
  }),
  spanRow({
    span_id: "a3",
    service: "worker",
    start_time: chTimestamp(hoursAgo(3)),
    gen_ai_system: "anthropic",
    gen_ai_request_model: "claude-haiku",
    input_tokens: 8,
    output_tokens: 4,
    cost_usd: 0.125,
  }),
  // The unpriced call: 15 tokens moved, ingest found no price row, and the
  // column it left behind is indistinguishable from free.
  spanRow({
    span_id: "a4",
    service: "worker",
    start_time: chTimestamp(hoursAgo(1)),
    gen_ai_system: "custom",
    gen_ai_request_model: "acme-ft",
    input_tokens: 12,
    output_tokens: 3,
    cost_usd: 0,
  }),
  // Not an LLM call. It carries tokens and no cost, so dropping the layer fence
  // would not just add a call — it would add an UNPRICED one, and name a model
  // the workspace never called.
  spanRow({
    span_id: "a5",
    service: "agent",
    layer: "tool",
    start_time: chTimestamp(hoursAgo(1)),
    gen_ai_request_model: "toolformer",
    input_tokens: 7,
    output_tokens: 2,
    cost_usd: 0,
  }),
  // 25h old: the mutation-proven window bound. Drop it and every 24h number
  // below moves by $100, a call, and a whole model.
  spanRow({
    span_id: "a6",
    service: "agent",
    start_time: chTimestamp(hoursAgo(25)),
    gen_ai_request_model: "ancient-model",
    input_tokens: 1000,
    output_tokens: 1000,
    cost_usd: 100,
  }),
];

/** The same model and service NAMES in a second tenant, with different money. */
const WORKSPACE_B_SPANS = [
  spanRow({
    workspace_id: WORKSPACE_B,
    span_id: "b1",
    service: "agent",
    start_time: chTimestamp(hoursAgo(1)),
    gen_ai_system: "custom",
    // Priced HERE and unpriced in A: the unpriced list is scoped like
    // everything else, so B's copy of the name must not inherit A's silence.
    gen_ai_request_model: "acme-ft",
    input_tokens: 5,
    output_tokens: 5,
    cost_usd: 9.5,
  }),
];

/** One more model than the cap, ranked by spend so the truncated one is known by name. */
const CAP_SPANS = Array.from({ length: COSTS_GROUP_CAP + 1 }, (_, i) =>
  spanRow({
    workspace_id: WORKSPACE_CAP,
    span_id: `cap${i}`,
    service: "capper",
    start_time: chTimestamp(hoursAgo(1)),
    gen_ai_request_model: `cap-model-${String(i).padStart(2, "0")}`,
    input_tokens: 10,
    output_tokens: 1,
    cost_usd: (i + 1) * 0.25,
  }),
);

/**
 * D472: the chart covers exactly the window the totals do, so a call at either
 * END of the window is the thing that can fall between them. Each of these sits
 * 10 minutes inside one range's far edge — in the leading, CLIPPED slot — and
 * the last sits in the bucket now filling. Every figure is binary-exact.
 */
const EDGE_SPANS = [
  { span_id: "e1", start_time: chTimestamp(minutesAgo(24 * 60 - 10)), cost_usd: 0.5 },
  { span_id: "e2", start_time: chTimestamp(minutesAgo(7 * 24 * 60 - 10)), cost_usd: 0.25 },
  { span_id: "e3", start_time: chTimestamp(minutesAgo(30 * 24 * 60 - 10)), cost_usd: 0.125 },
  { span_id: "e4", start_time: chTimestamp(minutesAgo(30)), cost_usd: 0.0625 },
].map((edge) =>
  spanRow({
    workspace_id: WORKSPACE_EDGE,
    service: "edge",
    gen_ai_request_model: "gpt-4o",
    input_tokens: 10,
    output_tokens: 1,
    ...edge,
  }),
);

/** What each range's window reaches, and what the chart's head must therefore draw. */
const EDGE_WINDOWS = [
  { range: "24h" as const, costUsd: 0.5625, calls: 2, head: 0.5 },
  { range: "7d" as const, costUsd: 0.8125, calls: 3, head: 0.25 },
  { range: "30d" as const, costUsd: 0.9375, calls: 4, head: 0.125 },
];

test("LLM unit economics (D460/D461) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    const why = `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`;
    assert.ok(!process.env.CI, why);
    t.skip(`${why} — skipped locally, fails on CI`);
    return;
  }

  const { queryCosts } = await import("./costs");

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [...WORKSPACE_A_SPANS, ...WORKSPACE_B_SPANS, ...CAP_SPANS, ...EDGE_SPANS],
  });

  const ch = forWorkspace(WORKSPACE_ID);

  await t.test("the totals: four LLM calls, one of them unpriced, and nothing else's spans", async () => {
    const report = await queryCosts(ch, "24h");
    assert.equal(report.range, "24h");
    assert.deepEqual(report.totals, {
      costUsd: 0.875,
      inputTokens: 170,
      outputTokens: 37,
      // The `tool` span and the 25h-old call are both absent: five spans are in
      // this workspace's window and four of them are LLM calls.
      calls: 4,
      unpricedCalls: 1,
    });
  });

  await t.test("totals.costUsd IS the window's sum(cost_usd) — the report cannot drift from the table", async () => {
    const report = await queryCosts(ch, "24h");
    const [direct] = await ch.queryRows<{ total: number }>(`
      SELECT sum(cost_usd) AS total
      FROM obstack.spans
      WHERE workspace_id = {workspace_id:String}
        AND layer = 'llm'
        AND start_time >= now() - toIntervalHour(24)`);
    assert.equal(report.totals.costUsd, direct.total);
    assert.equal(direct.total, 0.875);
  });

  await t.test("by model: response-model-first identity, ranked by spend", async () => {
    const report = await queryCosts(ch, "24h");
    assert.deepEqual(report.byModel, [
      // `gpt-4o-2024-08` was what the caller ASKED for; the provider answered as
      // `gpt-4o`, and that is the model the workspace was billed for.
      {
        model: "gpt-4o",
        system: "openai",
        costUsd: 0.75,
        inputTokens: 150,
        outputTokens: 30,
        calls: 2,
        unpricedCalls: 0,
      },
      {
        model: "claude-haiku",
        system: "anthropic",
        costUsd: 0.125,
        inputTokens: 8,
        outputTokens: 4,
        calls: 1,
        unpricedCalls: 0,
      },
      // Last by spend BECAUSE it has none to show — which is exactly why it also
      // gets a list of its own below.
      {
        model: "acme-ft",
        system: "custom",
        costUsd: 0,
        inputTokens: 12,
        outputTokens: 3,
        calls: 1,
        unpricedCalls: 1,
      },
    ]);
    assert.equal(report.totalModels, 3, "`toolformer` and `ancient-model` are not in this window's LLM calls");
  });

  await t.test("by service: spend and its distinct model count, ranked by spend", async () => {
    const report = await queryCosts(ch, "24h");
    assert.deepEqual(report.byService, [
      { service: "agent", costUsd: 0.75, calls: 2, unpricedCalls: 0, modelCount: 1 },
      { service: "worker", costUsd: 0.125, calls: 2, unpricedCalls: 1, modelCount: 2 },
    ]);
    assert.equal(report.totalServices, 2);
  });

  await t.test("the unpriced call is NAMED, never folded into $0 (D461)", async () => {
    const report = await queryCosts(ch, "24h");
    assert.deepEqual(report.unpricedModels, [{ model: "acme-ft", calls: 1 }]);
    assert.equal(report.totalUnpricedModels, 1);
    // The same call, told three ways, all of them from the same seeded row: a
    // count in the totals, a per-model count, and a name in its own list.
    assert.equal(report.totals.unpricedCalls, 1);
    assert.equal(report.byModel.find((m) => m.model === "acme-ft")?.unpricedCalls, 1);
    // A priced model never appears here, however cheap it is.
    assert.equal(report.unpricedModels.some((m) => m.model === "claude-haiku"), false);
  });

  await t.test("the hourly grid draws the window's spend, and every empty hour as 0", async () => {
    const report = await queryCosts(ch, "24h");
    // 24 whole hours plus the leading clipped slot, unless the window opened
    // exactly on the hour (D472) — the count is the wall clock's, the sum is not.
    assert.ok([24, 25].includes(report.series.length), `${report.series.length} points`);
    assert.equal(report.series.reduce((sum, p) => sum + p.costUsd, 0), 0.875);
    assert.equal(report.series.reduce((sum, p) => sum + p.calls, 0), 4);
    // The four calls are 1h, 1h, 2h and 3h old: three distinct hourly slots.
    const empty = report.series.filter((p) => p.calls === 0);
    assert.equal(empty.length, report.series.length - 3);
    assert.deepEqual([...new Set(empty.map((p) => p.costUsd))], [0], "an hour with no call is 0, not a gap");
  });

  await t.test("D472: on every range, the bars sum to the headline — both edges included", async () => {
    const edge = forWorkspace(WORKSPACE_EDGE);
    for (const { range, costUsd, calls, head } of EDGE_WINDOWS) {
      const report = await queryCosts(edge, range);
      // The far-edge call is 10 minutes INSIDE this range and outside the
      // narrower ones: proof the window the chart draws is the window the
      // totals count, not a grid-aligned approximation of it.
      assert.equal(report.totals.costUsd, costUsd, `${range} totals`);
      assert.equal(report.totals.calls, calls, `${range} calls`);
      assert.ok(
        Math.abs(report.series.reduce((sum, p) => sum + p.costUsd, 0) - report.totals.costUsd) < 1e-12,
        `${range}: the series sums to ${report.series.reduce((sum, p) => sum + p.costUsd, 0)}, totals say ${report.totals.costUsd}`,
      );
      assert.equal(
        report.series.reduce((sum, p) => sum + p.calls, 0),
        report.totals.calls,
        `${range}: every call the totals counted is drawn somewhere`,
      );
      // It is drawn at the HEAD: in the clipped first slot, or in the second
      // when the clock leaves less than 10 minutes of the first one.
      assert.equal(report.series[0].costUsd + report.series[1].costUsd, head, `${range} head`);
      // A slot per bucket plus the clipped one, minus the boundary case.
      const bucketMs = { "24h": 3_600_000, "7d": 21_600_000, "30d": 86_400_000 }[range];
      const ts = report.series.map((p) => Date.parse(p.t));
      assert.ok(ts.slice(1).every((v) => v % bucketMs === 0), `${range}: only the first slot is off-boundary`);
    }
  });

  await t.test("D472: the same identity holds for a workspace with calls in mid-window", async () => {
    for (const range of ["24h", "7d", "30d"] as const) {
      const report = await queryCosts(ch, range);
      assert.ok(
        Math.abs(report.series.reduce((sum, p) => sum + p.costUsd, 0) - report.totals.costUsd) < 1e-12,
        `${range}: the chart and the stat card disagree`,
      );
      assert.equal(report.series.reduce((sum, p) => sum + p.calls, 0), report.totals.calls, range);
    }
  });

  await t.test("the range picker is a real window: 7d reaches the 25h-old call, 24h does not", async () => {
    const week = await queryCosts(ch, "7d");
    assert.equal(week.range, "7d");
    assert.equal(week.totals.costUsd, 100.875);
    assert.equal(week.totals.calls, 5);
    assert.equal(week.totalModels, 4);
    assert.ok([28, 29].includes(week.series.length), `${week.series.length} points`);
    assert.equal(week.byModel[0].model, "ancient-model", "$100 outranks the rest of the week");
  });

  await t.test("a second workspace sees none of it — even under the same model and service names", async () => {
    const b = forWorkspace(WORKSPACE_B);
    const report = await queryCosts(b, "24h");
    assert.equal(report.totals.costUsd, 9.5, "tenant B's own money, never tenant A's $0.875");
    assert.equal(report.totals.calls, 1);
    assert.equal(report.totals.unpricedCalls, 0);
    assert.deepEqual(report.byModel.map((m) => m.model), ["acme-ft"]);
    assert.equal(report.byModel[0].costUsd, 9.5);
    assert.deepEqual(report.byService, [
      { service: "agent", costUsd: 9.5, calls: 1, unpricedCalls: 0, modelCount: 1 },
    ]);
    assert.equal(report.totalServices, 1, "A's `worker` is the other tenant's");
    // `acme-ft` is unpriced in A and priced here: the unpriced list is scoped
    // like every other number on the page.
    assert.deepEqual(report.unpricedModels, []);
    assert.equal(report.totalUnpricedModels, 0);
  });

  await t.test("D402: the cap truncates the models and the total says by how much", async () => {
    const report = await queryCosts(forWorkspace(WORKSPACE_CAP), "24h");
    assert.equal(report.byModel.length, COSTS_GROUP_CAP);
    assert.equal(report.totalModels, COSTS_GROUP_CAP + 1, "the pre-cap count, not the page length");
    assert.equal(report.byModel[0].model, "cap-model-10", "ranked by spend, highest first");
    assert.equal(
      report.byModel.some((m) => m.model === "cap-model-00"),
      false,
      "the cheapest model is the one the cap dropped",
    );
    // Truncated rows, whole totals: the stat cards are the workspace's, not the
    // table's.
    assert.equal(report.totals.calls, COSTS_GROUP_CAP + 1);
    assert.equal(report.totals.costUsd, 16.5);
  });
});
