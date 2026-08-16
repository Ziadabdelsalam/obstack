/**
 * D46 latency record — NO skip index this sprint; this harness measures the
 * free-text scan cost the traces-list search pays on a seeded dataset (≥10k
 * traces, ≥100k `logs` rows), cold and warm, and the numbers join T1's
 * contract review. The index decision is pre-registered as an M3-planning
 * item with this measurement as its evidence (D46).
 *
 * Test/fixture territory only: no product code imports this file, and the
 * `.bench.ts` suffix keeps it outside the `src/**\/*.test.ts` glob, so
 * `npm test` never runs it.
 *
 * Usage (from `apps/web`; every fixing value explicit, S2.2 L3/L2). The seed
 * step assumes a CLEAN volume — it writes a fixed workspace and running it
 * twice doubles the rows (the measure step prints the row counts it saw, so a
 * double-seed is visible in the record):
 *
 *   1) cd deploy/compose && docker compose down -v \
 *        && docker compose up -d --wait clickhouse ingest
 *   2) npx tsx --conditions react-server src/server/queries/search-latency.bench.ts seed
 *   3) docker restart obstack-clickhouse   # empty ClickHouse's own caches for the cold run
 *   4) npx tsx --conditions react-server src/server/queries/search-latency.bench.ts measure
 *      -> run 1 = cold (first query after the server restart; the host page
 *         cache is NOT purged — stated, not hidden), warm = median of the
 *         following runs
 *
 * Env (defaults match deploy/compose/README.md's dev credentials):
 * CLICKHOUSE_URL, CLICKHOUSE_USER/CLICKHOUSE_PASSWORD (web read path),
 * OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD (seeding side channel).
 */
import os from "node:os";
import { performance } from "node:perf_hooks";
import { createClient } from "@clickhouse/client";

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

/** Fixed bench workspace: `measure` needs no state from `seed` beyond this name. */
const WORKSPACE_ID = "ws_bench_d46";

// The web read path resolves its client lazily on the first query — set env
// before `./traces` is imported below (the integration test's pattern).
process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
process.env.CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
process.env.OBSTACK_WORKSPACE_ID = WORKSPACE_ID;

const TRACES = 10_000;
const LOGS_PER_TRACE = 10; // 100k logs rows total
const BATCH = 5_000;

/** Trace whose first log body carries the log-leg needle. */
const LOG_NEEDLE_TRACE = 7_777;
/** Trace whose span prompt carries the spans-leg needle. */
const PROMPT_NEEDLE_TRACE = 3_333;

const seed = createClient({
  url: CLICKHOUSE_URL,
  username: "obstack_ingest",
  password: INGEST_PASSWORD,
  database: "obstack",
});

/** DateTime64 insert format at millisecond precision — enough for a latency fixture. */
const chTs = (ms: number): string => new Date(ms).toISOString().slice(0, 23).replace("T", " ");

function spanRow(t: number, startMs: number) {
  return {
    workspace_id: WORKSPACE_ID,
    trace_id: `bench_${String(t).padStart(5, "0")}`,
    span_id: "s1",
    parent_span_id: "",
    name: `POST /v1/chat route-${t % 7}`,
    kind: "server",
    service: "bench-svc",
    start_time: chTs(startMs),
    duration_ns: String(1_000_000 * (50 + (t % 900))),
    status_code: t % 25 === 0 ? "error" : "ok",
    status_message: "",
    layer: "llm",
    gen_ai_system: "openai",
    gen_ai_request_model: "gpt-4o-mini",
    gen_ai_response_model: "gpt-4o-mini",
    input_tokens: 60 + (t % 40),
    output_tokens: 20 + (t % 30),
    cost_usd: 0.00001 * (t % 50),
    finish_reason: "stop",
    prompt: `user: customer ${t} asks why the invoice total moved after the API key rotation; prior thread context attached, plan tier ${t % 5}${t === PROMPT_NEEDLE_TRACE ? " d46promptneedle" : ""}`,
    completion: `the charge on invoice ${t} splits into subscription plus metered overage from cycle ${t % 12}; both invoice links attached for review`,
    k8s_namespace: "",
    k8s_pod: "",
    k8s_container: "app",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
  };
}

function logRow(t: number, i: number, atMs: number) {
  return {
    workspace_id: WORKSPACE_ID,
    timestamp: chTs(atMs),
    trace_id: `bench_${String(t).padStart(5, "0")}`,
    span_id: "s1",
    severity_number: 9,
    severity_text: "INFO",
    body: `req ${t} step ${i}: cache lookup ${12 + ((t + i) % 90)}ms, retry budget ok, upstream vector store answered with ${3 + (i % 9)} chunks, payload digest ${(t * 31 + i).toString(16)}${t === LOG_NEEDLE_TRACE && i === 0 ? " d46needle" : ""}`,
    service: "bench-svc",
    prompt: "",
    completion: "",
    k8s_namespace: "",
    k8s_pod: "",
    k8s_container: "app",
    attributes: {},
    resource_attributes: {},
  };
}

async function insertBatches(table: string, rows: object[]): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) {
    await seed.insert({ table, format: "JSONEachRow", values: rows.slice(i, i + BATCH) });
  }
}

async function doSeed(): Promise<void> {
  const base = Date.now() - 3_600_000; // all rows inside the last hour → inside the 6h default window
  const spans: object[] = [];
  const logs: object[] = [];
  for (let t = 0; t < TRACES; t++) {
    const startMs = base + Math.floor((t / TRACES) * 3_000_000);
    spans.push(spanRow(t, startMs));
    for (let i = 0; i < LOGS_PER_TRACE; i++) logs.push(logRow(t, i, startMs + i * 10));
  }
  await insertBatches("spans", spans);
  await insertBatches("logs", logs);
  console.log(`seeded workspace ${WORKSPACE_ID}: ${TRACES} traces / ${spans.length} spans / ${logs.length} logs rows`);
  console.log("next: docker restart obstack-clickhouse, then run the measure step");
}

async function count(table: string): Promise<number> {
  const r = await seed.query({
    query: `SELECT count() AS n FROM obstack.${table} WHERE workspace_id = {ws:String}`,
    query_params: { ws: WORKSPACE_ID },
    format: "JSONEachRow",
  });
  const [row] = await r.json<{ n: string }>();
  return Number(row.n);
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function doMeasure(): Promise<void> {
  const { queryTraceSearch } = await import("./traces");
  const [spanCount, logCount] = await Promise.all([count("spans"), count("logs")]);
  console.log(`dataset: workspace ${WORKSPACE_ID}, ${spanCount} spans rows, ${logCount} logs rows`);
  console.log(
    `machine: ${os.cpus()[0].model} (${os.cpus().length} cores), ${Math.round(os.totalmem() / 1e9)} GB RAM, node ${process.version}; ` +
      "ClickHouse clickhouse/clickhouse-server:26.3.17.110 in Docker Desktop (deploy/compose)",
  );
  const cases: { label: string; filter: Parameters<typeof queryTraceSearch>[0]; expectTotal: number }[] = [
    { label: "free text, log-body needle (1 match)", filter: { q: "d46needle" }, expectTotal: 1 },
    { label: "free text, span-prompt needle (1 match)", filter: { q: "d46promptneedle" }, expectTotal: 1 },
    { label: "free text, absent term (0 matches, full scan)", filter: { q: "d46absent" }, expectTotal: 0 },
    // Cost scales with TERM COUNT, not with match count: every term appends its
    // own pair of semi-join subqueries, so an N-term query pays N full scans of
    // `spans` and `logs`. A single-term number alone would understate what the
    // M3 index decision is being asked to price, so the record carries both
    // ends — and a high-cardinality term (semi-join set = every trace) to show
    // that a large result set is not itself the cost driver.
    { label: "free text, high-cardinality term (matches every trace)", filter: { q: "cache" }, expectTotal: TRACES },
    { label: "free text, FOUR terms (4x semi-join scans) — worst case measured", filter: { q: "cache retry upstream digest" }, expectTotal: TRACES },
    { label: "no free text, default first page", filter: {}, expectTotal: TRACES },
  ];
  for (const c of cases) {
    const runs: number[] = [];
    let total = -1;
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const r = await queryTraceSearch(c.filter);
      runs.push(performance.now() - t0);
      total = r.total;
    }
    const ok = total === c.expectTotal ? "" : `  !! expected total ${c.expectTotal}`;
    console.log(
      `${c.label}: total=${total}${ok}\n  run1 (cold if server was restarted): ${runs[0].toFixed(0)} ms; warm median of runs 2-6: ${median(runs.slice(1)).toFixed(0)} ms; all: [${runs.map((x) => x.toFixed(0)).join(", ")}] ms`,
    );
  }
  await seed.close();
}

const mode = process.argv[2];
if (mode === "seed") {
  doSeed().then(() => seed.close());
} else if (mode === "measure") {
  doMeasure();
} else {
  console.error("usage: search-latency.bench.ts <seed|measure>  (see the header comment)");
  process.exit(2);
}
