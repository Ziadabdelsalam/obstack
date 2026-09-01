import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";
import { SERVICE_CAP } from "@/lib/services-types";
import { forWorkspace } from "@/server/clickhouse";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse
// then:     npm test --workspace apps/web
// (down -v first for a clean volume — see deploy/compose/README.md)
//
// The seeded-ClickHouse half of the D397 contract: the numbers themselves.
// `services.test.ts` proves what the module SENDS; only a real server proves
// what the statements COMPUTE — the plurality-layer pick with its `layerOrder`
// tie-break, the interpolated quantiles, the 24h bound, the `-Merge` read of
// `trace_summaries`, and the D402 cap. Seeding writes spans through the ingest
// user; `trace_summaries_mv` fires on that INSERT, so the summaries half needs
// no extra fixture.
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
 * grant, so nothing here can be cleaned up afterwards. `WORKSPACE_B` carries a
 * service with the SAME NAME as A's, which is the only fixture that can tell a
 * scoped read from an unscoped one; `WORKSPACE_CAP` exists so the D402 cap can
 * be proven against a set larger than it.
 */
const WORKSPACE_ID = `ws_it_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_itb_${randomBytes(4).toString("hex")}`;
const WORKSPACE_CAP = `ws_itc_${randomBytes(4).toString("hex")}`;

const NS_PER_SECOND = BigInt(1_000_000_000);
const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'` — traces.integration.test.ts's `chTimestamp`. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / NS_PER_SECOND;
  const nanos = epochNs % NS_PER_SECOND;
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

/** What `formatDateTime(..., '%Y-%m-%dT%H:%iZ', 'UTC')` renders for the same instant. */
function isoMinute(epochNs: bigint): string {
  const ms = Number(epochNs / NS_PER_MS);
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

const NOW_NS = BigInt(Date.now()) * NS_PER_MS;
const hoursAgo = (h: number): bigint => NOW_NS - BigInt(Math.round(h * 3_600_000)) * NS_PER_MS;

const TRACE_A = randomBytes(16).toString("hex"); // 3h ago — error inside svc-alpha
const TRACE_B = randomBytes(16).toString("hex"); // 2h ago — error in ANOTHER service of the trace
const TRACE_C = randomBytes(16).toString("hex"); // 1h ago — no error at all
const TRACE_D = randomBytes(16).toString("hex"); // 25h ago — outside the window
const TRACE_E = randomBytes(16).toString("hex"); // svc-beta's layer tie
const TRACE_F = randomBytes(16).toString("hex"); // a span carrying no service name

function spanRow(overrides: {
  trace_id: string;
  span_id: string;
  start_time: string;
  duration_ns: string;
  service: string;
  workspace_id?: string;
  parent_span_id?: string;
  name?: string;
  status_code?: string;
  layer?: string;
  cost_usd?: number;
  gen_ai_request_model?: string;
}) {
  return {
    workspace_id: WORKSPACE_ID,
    parent_span_id: "",
    name: "POST /alpha",
    kind: "server",
    status_code: "ok",
    status_message: "",
    layer: "api",
    gen_ai_system: "",
    gen_ai_request_model: "",
    gen_ai_response_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    finish_reason: "",
    prompt: "",
    completion: "",
    k8s_namespace: "",
    k8s_pod: "",
    k8s_container: "",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
}

const ms = (n: number): string => String(n * 1_000_000);

/**
 * svc-alpha's four in-window spans are 10/20/30/40ms with exactly one error,
 * three of them on layer `api` and one on `tool`, and a fifth span 25h old
 * that every assertion below must ignore. Every number the catalog renders is
 * therefore pinned by construction rather than measured after the fact.
 */
const ALPHA_SPANS = [
  spanRow({
    trace_id: TRACE_A,
    span_id: "a1",
    service: "svc-alpha",
    start_time: chTimestamp(hoursAgo(3)),
    duration_ns: ms(10),
    cost_usd: 0.25,
    gen_ai_request_model: "gpt-4o",
  }),
  spanRow({
    trace_id: TRACE_A,
    span_id: "a2",
    parent_span_id: "a1",
    name: "alpha.step",
    service: "svc-alpha",
    status_code: "error",
    start_time: chTimestamp(hoursAgo(3) + NS_PER_MS),
    duration_ns: ms(20),
    cost_usd: 0.25,
    gen_ai_request_model: "gpt-4o-mini",
  }),
  spanRow({
    trace_id: TRACE_B,
    span_id: "b1",
    name: "POST /alpha-b",
    service: "svc-alpha",
    layer: "tool",
    start_time: chTimestamp(hoursAgo(2)),
    duration_ns: ms(30),
  }),
  spanRow({
    trace_id: TRACE_C,
    span_id: "c1",
    service: "svc-alpha",
    start_time: chTimestamp(hoursAgo(1)),
    duration_ns: ms(40),
  }),
  // 25h old: the mutation-proven bound. Drop the window predicate and this row
  // adds a span, $100, a model, an error and a whole span name to every
  // assertion below — including a trace to the error list.
  spanRow({
    trace_id: TRACE_D,
    span_id: "d1",
    name: "ancient.call",
    service: "svc-alpha",
    layer: "llm",
    status_code: "error",
    start_time: chTimestamp(hoursAgo(25)),
    duration_ns: ms(999),
    cost_usd: 100,
    gen_ai_request_model: "ancient-model",
  }),
];

const OTHER_SPANS = [
  // TRACE_B's error lives in a DIFFERENT service — the summaries read answers
  // "traces this service took part in that carry an error", and this row is
  // what makes that claim observable rather than incidental.
  spanRow({
    trace_id: TRACE_B,
    span_id: "b2",
    parent_span_id: "b1",
    name: "gamma.call",
    service: "svc-gamma",
    status_code: "error",
    start_time: chTimestamp(hoursAgo(2) + NS_PER_MS),
    duration_ns: ms(5),
  }),
  // svc-beta: one span on `llm`, one on `api` — a perfect plurality tie, which
  // `layerOrder` breaks toward `api` (index 0) every time.
  spanRow({
    trace_id: TRACE_E,
    span_id: "e1",
    name: "POST /beta",
    service: "svc-beta",
    layer: "llm",
    start_time: chTimestamp(hoursAgo(0.5)),
    duration_ns: ms(5),
  }),
  spanRow({
    trace_id: TRACE_E,
    span_id: "e2",
    parent_span_id: "e1",
    name: "beta.step",
    service: "svc-beta",
    layer: "api",
    start_time: chTimestamp(hoursAgo(0.5) + NS_PER_MS),
    duration_ns: ms(5),
  }),
  // A span that names no service is not a service (the `trace_summaries_mv`'s
  // own rule): it must not become a catalog row with an empty name and a
  // broken link.
  spanRow({
    trace_id: TRACE_F,
    span_id: "f1",
    name: "orphan",
    service: "",
    start_time: chTimestamp(hoursAgo(0.5)),
    duration_ns: ms(5),
  }),
];

/** The same service NAME in a second tenant, with different numbers — a scoped read cannot borrow them. */
const TENANT_B_SPANS = [
  spanRow({
    workspace_id: WORKSPACE_B,
    trace_id: randomBytes(16).toString("hex"),
    span_id: "tb1",
    name: "POST /alpha",
    service: "svc-alpha",
    status_code: "error",
    start_time: chTimestamp(hoursAgo(1)),
    duration_ns: ms(7),
    cost_usd: 9.99,
  }),
];

/** One more service than the cap, so the banner's "N of M" has something to truncate. */
const CAP_SPANS = Array.from({ length: SERVICE_CAP + 1 }, (_, i) =>
  spanRow({
    workspace_id: WORKSPACE_CAP,
    trace_id: randomBytes(16).toString("hex"),
    span_id: `cap${i}`,
    name: "POST /cap",
    service: `cap-svc-${String(i).padStart(3, "0")}`,
    start_time: chTimestamp(hoursAgo(1)),
    duration_ns: ms(1),
  }),
);

test("the trace-derived catalog and one service's detail (D397) against a seeded ClickHouse", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(`no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`);
    return;
  }

  const { getService, listServices } = await import("./services");

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [...ALPHA_SPANS, ...OTHER_SPANS, ...TENANT_B_SPANS, ...CAP_SPANS],
  });

  const ch = forWorkspace(WORKSPACE_ID);

  await t.test("the catalog: one row per named service, ranked by span volume", async () => {
    const list = await listServices(ch);
    assert.deepEqual(
      list.rows.map((r) => r.name),
      ["svc-alpha", "svc-beta", "svc-gamma"],
      "ranked by spans (4, 2, 1); the service-less span produced no row at all",
    );
    assert.equal(list.totalServices, 3);
  });

  await t.test("one row's every number, exactly (D397)", async () => {
    const [alpha] = (await listServices(ch)).rows;
    assert.equal(alpha.spans, 4, "the 25h-old span is outside the window");
    assert.equal(alpha.spansPerMin, 4 / 1440);
    assert.equal(alpha.errorPct, 25, "one error span in four");
    // quantile() interpolates over the sorted sample: p50 of [10,20,30,40] is
    // halfway between 20 and 30; p95 is 85% of the way from 30 to 40. The
    // second one is 38.499999999999996 in float64, which is the arithmetic
    // being right, not the query being approximate.
    assert.equal(alpha.p50Ms, 25);
    assert.ok(Math.abs(alpha.p95Ms - 38.5) < 1e-6, `p95 was ${alpha.p95Ms}`);
    assert.equal(alpha.costUsd, 0.5, "the 25h-old span's $100 is outside the window");
    assert.deepEqual(alpha.models, ["gpt-4o", "gpt-4o-mini"]);
    assert.equal(alpha.layer, "api", "three api spans against one tool span");
    assert.equal(alpha.lastSeenAt, isoMinute(hoursAgo(1)));
  });

  await t.test("a plurality tie is broken by layerOrder, not by whichever layer was seen first", async () => {
    const beta = (await listServices(ch)).rows.find((r) => r.name === "svc-beta");
    assert.equal(beta?.layer, "api", "one llm span against one api span — layerOrder names api first");
    assert.equal(beta?.spans, 2);
    assert.equal(beta?.errorPct, 0);
  });

  await t.test("the detail: span names capped and totalled, error traces merged from the summaries", async () => {
    const detail = await getService(ch, "svc-alpha");
    assert.ok(detail);
    assert.equal(detail.spans, 4, "the detail row is the catalog row");
    assert.deepEqual(detail.topSpanNames, [
      { name: "POST /alpha", count: 2, errorPct: 0 },
      { name: "POST /alpha-b", count: 1, errorPct: 0 },
      { name: "alpha.step", count: 1, errorPct: 100 },
    ]);
    assert.equal(detail.totalSpanNames, 3, "`ancient.call` is outside the window");
    assert.deepEqual(detail.recentErrorTraces, [
      // Most recent first. TRACE_B's error belongs to svc-gamma, and the trace
      // still qualifies: this is the claim the surface prints in words.
      { traceId: TRACE_B, rootName: "POST /alpha-b", startedAt: isoMinute(hoursAgo(2)) },
      { traceId: TRACE_A, rootName: "POST /alpha", startedAt: isoMinute(hoursAgo(3)) },
    ]);
    // TRACE_C has svc-alpha and no error; TRACE_D has both but is 25h old.
    const ids = detail.recentErrorTraces.map((tr) => tr.traceId);
    assert.equal(ids.includes(TRACE_C), false);
    assert.equal(ids.includes(TRACE_D), false);
  });

  await t.test("a service the workspace never sent a span from is null", async () => {
    assert.equal(await getService(ch, "svc-never"), null);
    // The service-less span (`service = ''`) is in the window and still names
    // no service, so the empty name resolves to nothing rather than to it.
    assert.equal(await getService(ch, ""), null);
  });

  await t.test("a second workspace sees none of it — even under the same service name", async () => {
    const b = forWorkspace(WORKSPACE_B);
    const list = await listServices(b);
    assert.deepEqual(list.rows.map((r) => r.name), ["svc-alpha"]);
    assert.equal(list.totalServices, 1, "svc-beta and svc-gamma are the other tenant's");
    const detail = await getService(b, "svc-alpha");
    assert.equal(detail?.spans, 1, "tenant B's own single span, never tenant A's four");
    assert.equal(detail?.costUsd, 9.99);
    assert.equal(detail?.errorPct, 100);
    assert.deepEqual(detail?.recentErrorTraces.map((tr) => tr.traceId).includes(TRACE_A), false);
    assert.deepEqual(detail?.topSpanNames, [{ name: "POST /alpha", count: 1, errorPct: 100 }]);
  });

  await t.test("D402: the cap truncates the rows and the total says by how much", async () => {
    const list = await listServices(forWorkspace(WORKSPACE_CAP));
    assert.equal(list.rows.length, SERVICE_CAP);
    assert.equal(list.totalServices, SERVICE_CAP + 1, "the total is the pre-cap count, not the page length");
  });
});
