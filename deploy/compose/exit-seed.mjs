/**
 * The evidence dataset the `e2e` drive seeds (T5, extended by F8 and S3.3).
 *
 * THREE SEEDINGS LIVE HERE, one per store, and they are invoked separately
 * because they answer different questions. `--workspace/--label` writes the
 * ClickHouse telemetry fixture described below; `--lower-free-quota` writes the
 * single Postgres row the S3.3 metering step needs (D172) and touches nothing
 * else; `--leg metrics` sends the S6.1 metrics fixture through the product's
 * OWN front door — an OTLP export to the real `/v1/metrics`, never an insert
 * (D370). See "the quota seeding" and "the metrics seeding" at the bottom.
 *
 * Writes a DEDICATED workspace straight into ClickHouse through the ingest
 * user, so the run asserts against data whose exact shape is known here rather
 * than whatever a demo happens to emit. Everything it inserts is printed as
 * counts, and those counts are what the UI's "N of M" is checked against — an
 * independent denominator, which is also the phantom guard (D71(b)): no span
 * carries an empty trace_id, so no `trace_id=''` summary row can exist to
 * inflate a total.
 *
 * The dataset is deliberately larger than one page (`TRACE_PAGE_SIZE = 200`)
 * and larger than the logs cap (`LOG_SEARCH_CAP = 200`), so the totals claim is
 * about the data and the truncation marker is about the cap (S2.2 L2).
 *
 * Two tokens exist in exactly one place each, which is what makes the free-text
 * reach legs falsifiable end to end: SPAN_PROMPT_TOKEN appears only inside one
 * span's `prompt` column, LOG_BODY_TOKEN only inside one log row's `body`.
 * Neither appears in any name, service, model or id.
 *
 * TWO required arguments, no defaults and no env reads (D96/D113/D135), because
 * both are values only the caller can know:
 *
 *   --workspace   the workspace these rows belong to. The `e2e` drive passes the
 *                 real workspace a signup just created (D115) — a value no
 *                 default could ever hold.
 *   --label       the content label woven into this seeding's TEXT, so two
 *                 workspaces seeded from this one definition are distinguishable
 *                 by what they say and not only by how many rows they have. The
 *                 drive gives each stranger their own, and then asserts that a
 *                 tenant's surfaces carry their label and none of the other's
 *                 (D135) — an outer guard that shares no assumption with the
 *                 scoping tripwire it is supposed to catch failing.
 *
 * ONE seeding definition, parameterised — not two fixture shapes. Same counts,
 * same tokens, same ids whatever the label is; only the words differ.
 *
 *   node deploy/compose/exit-seed.mjs --workspace ws_1a2b3c --label zzalice
 *   SEED_METRICS_TOKEN=ok_live_… node deploy/compose/exit-seed.mjs --leg metrics \
 *     --workspace ws_1a2b3c --label zzalice
 *   node deploy/compose/exit-seed.mjs --lower-free-quota
 */

import pg from "pg";

const CH = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const USER = process.env.CLICKHOUSE_INGEST_USER ?? "obstack_ingest";
const PASSWORD = process.env.CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";
const PG_DSN =
  process.env.OBSTACK_POSTGRES_DSN ?? "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack";
/** OTLP/HTTP, the wire contract a customer's exporter speaks (D6) — the metrics
 *  leg's only destination, because it is the only leg that goes in the front. */
const OTLP = process.env.INGEST_OTLP ?? "http://127.0.0.1:4318";

const USAGE =
  "usage: node deploy/compose/exit-seed.mjs --workspace <workspace_id> --label <label>\n" +
  "       node deploy/compose/exit-seed.mjs --leg metrics --workspace <workspace_id> --label <label>\n" +
  "         (with SEED_METRICS_TOKEN=<that workspace's own ok_live_ key> in the environment)\n" +
  "       node deploy/compose/exit-seed.mjs --lower-free-quota";

/** Which store this invocation writes to. Absent is the ClickHouse fixture, so
 *  the default invocation is exactly the one it always was. */
const LEGS = ["clickhouse", "metrics"];
function legOf(argv) {
  const at = argv.indexOf("--leg");
  if (at === -1) return "clickhouse";
  const value = argv[at + 1];
  if (!LEGS.includes(value)) throw new Error(`--leg must be one of ${LEGS.join("|")} — ${USAGE}`);
  return value;
}

/**
 * Refused rather than defaulted, both of them: a seeder that guessed would
 * silently pour a 220-trace fixture into whichever workspace the guess named,
 * and label it with whatever the guess said it was. The caller that has to be
 * told these is exactly the caller that knows them (S2.2 L3 — a run states its
 * fixing values because it was given them).
 */
function requiredArg(argv, flag) {
  const at = argv.indexOf(flag);
  const value = at === -1 ? undefined : argv[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required — ${USAGE}`);
  return value;
}

/** More than TRACE_PAGE_SIZE, so page 2 exists and is short. */
const TRACES = 220;
/** More than LOG_SEARCH_CAP, so the truncation marker is proven by data. */
const BULK_LOGS = 240;

export const SPAN_PROMPT_TOKEN = "zzpromptonlytoken";
export const LOG_BODY_TOKEN = "zzlogbodyonlytoken";
/** Content on a D42 carrier row (empty body): searchable on traces, never on /app/logs. */
export const CARRIER_TOKEN = "zzcarrieronlytoken";

const now = Date.now();
const traceId = (i) => `e${String(i).padStart(3, "0")}${"0".repeat(28)}`.slice(0, 32);

/** DateTime64(9,'UTC') wants 'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'. */
function chTime(msAgo) {
  const d = new Date(now - msAgo);
  return `${d.toISOString().slice(0, 19).replace("T", " ")}.${String(d.getMilliseconds()).padStart(3, "0")}000000`;
}

/**
 * The label goes on CONTENT — the text a surface renders as words — and never on
 * an identifier. Services, pods, namespaces, models, layers and ids stay exactly
 * what they were, because the filter legs match those EXACTLY (`has(services,
 * …)`, `k8s_pod = …`) and a suffixed pod is simply a different pod.
 *
 * And never on an EMPTY field: the D42 carrier row's body is empty on purpose,
 * and a labelled empty body is a row that renders, which would quietly delete
 * the leg it exists for (D51(e)).
 */
const labelled = (text, label) => (text === "" ? "" : `${text} ${label}`);

/**
 * The label is applied LAST, over the overrides, for the same reason the
 * workspace stamp is (T5's review): a call site that passed its own `prompt`
 * would otherwise produce an unlabelled row inside a labelled workspace, and
 * the disjointness assertion would be reading a fixture with holes in it.
 */
function span(label, overrides) {
  const row = {
    parent_span_id: "",
    name: "POST /chat",
    kind: "server",
    service: "exit-gateway",
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
    k8s_namespace: "exit-ns",
    k8s_pod: "exit-app-1",
    k8s_container: "app",
    k8s_node: "exit-node",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
  return {
    ...row,
    name: labelled(row.name, label),
    prompt: labelled(row.prompt, label),
    completion: labelled(row.completion, label),
  };
}

function log(label, overrides) {
  const row = {
    trace_id: "",
    span_id: "",
    severity_number: 9,
    severity_text: "INFO",
    service: "exit-gateway",
    k8s_namespace: "exit-ns",
    k8s_pod: "exit-app-1",
    k8s_container: "app",
    prompt: "",
    completion: "",
    body: "",
    attributes: {},
    resource_attributes: {},
    ...overrides,
  };
  return {
    ...row,
    body: labelled(row.body, label),
    prompt: labelled(row.prompt, label),
    completion: labelled(row.completion, label),
  };
}

/** The trace findable ONLY through the span-prompt leg of the search contract. */
export const PROMPT_TRACE = traceId(5);
/** The trace findable ONLY through the log-body leg. */
export const LOG_TRACE = traceId(9);
/** The D42 content-carrier trace: non-empty prompt, EMPTY body. */
export const CARRIER_TRACE = traceId(11);

/**
 * The whole fixture, built for one label. Ids, counts, tokens, layers, services
 * and pods are identical whatever the label is — this is one shape seeded twice,
 * not two fixtures — and only the rendered words differ (D135).
 */
function dataset(label) {
  // ---- spans: one api root each, plus an llm child on the probe trace.
  // Ages are 1 minute apart from 2 minutes back, so every trace is inside the 6h
  // default window and the DESC order is total (no ties to hide a sort bug).
  const spans = [];
  for (let i = 0; i < TRACES; i++) {
    const msAgo = (i + 2) * 60_000;
    spans.push(
      span(label, {
        trace_id: traceId(i),
        span_id: `s${i}-root`,
        start_time: chTime(msAgo),
        duration_ns: String((120 + i) * 1_000_000),
        status_code: i % 20 === 7 ? "error" : "ok",
        service: i % 3 === 0 ? "exit-gateway" : "exit-agent",
      }),
    );
  }

  spans.push(
    span(label, {
      trace_id: PROMPT_TRACE,
      span_id: "s5-llm",
      parent_span_id: "s5-root",
      name: "chat.completion",
      layer: "llm",
      service: "exit-agent",
      start_time: chTime(7 * 60_000 - 1_000),
      duration_ns: String(90 * 1_000_000),
      gen_ai_system: "openai",
      gen_ai_request_model: "gpt-4o-mini",
      gen_ai_response_model: "gpt-4o-mini",
      input_tokens: 41,
      output_tokens: 17,
      cost_usd: 0.000031,
      finish_reason: "stop",
      prompt: `summarise the incident ${SPAN_PROMPT_TOKEN} for the on-call engineer`,
      completion: "the checkout deploy at 14:02 is the likeliest cause",
    }),
  );

  // ---- logs
  const logs = [];
  for (let i = 0; i < BULK_LOGS; i++) {
    logs.push(
      log(label, {
        timestamp: chTime((i + 1) * 60_000),
        body: `exit bulk line ${i} handled request`,
        trace_id: i % 8 === 0 ? traceId(i % TRACES) : "",
      }),
    );
  }

  logs.push(
    log(label, {
      timestamp: chTime(11 * 60_000),
      trace_id: LOG_TRACE,
      body: `checkout retry exhausted ${LOG_BODY_TOKEN} giving up`,
      severity_number: 17,
      severity_text: "ERROR",
      k8s_pod: "exit-db-0",
    }),
  );
  // A pod with a small, countable population, for the pod filter.
  for (let i = 0; i < 3; i++) {
    logs.push(
      log(label, { timestamp: chTime((i + 2) * 60_000), body: `exit db checkpoint ${i}`, k8s_pod: "exit-db-0" }),
    );
  }
  // The D42 carrier row. /app/logs must not render it, count it, or match it;
  // the traces list must still find its trace. Its body stays empty THROUGH the
  // labelling — see `labelled`.
  logs.push(
    log(label, {
      timestamp: chTime(13 * 60_000),
      trace_id: CARRIER_TRACE,
      body: "",
      prompt: `event-form prompt ${CARRIER_TOKEN}`,
      completion: "event-form completion",
      k8s_pod: "exit-carrier",
    }),
  );

  return { spans, logs };
}

/**
 * The one place tenancy is stamped onto the dataset. The builders above describe
 * SHAPE — a trace's layers, a log's severity, which token sits in which column —
 * and none of them names a workspace, so the fixture cannot half-belong to two.
 * The stamp goes on LAST so that stays true by construction rather than by
 * everyone remembering: a row that named a workspace could not outvote the
 * argument this run was given.
 */
async function insert(table, rows, workspace) {
  const query = encodeURIComponent(`INSERT INTO obstack.${table} FORMAT JSONEachRow`);
  const res = await fetch(`${CH}/?user=${USER}&password=${PASSWORD}&query=${query}`, {
    method: "POST",
    body: rows.map((r) => JSON.stringify({ ...r, workspace_id: workspace })).join("\n"),
  });
  if (!res.ok) throw new Error(`insert into ${table} failed: ${res.status} ${await res.text()}`);
}

async function count(sql) {
  const res = await fetch(`${CH}/?user=${USER}&password=${PASSWORD}`, { method: "POST", body: sql });
  return Number((await res.text()).trim());
}

// ------------------------------------------------------- the quota seeding
/**
 * The quota the S3.3 metering step meters against (D172).
 *
 * Fifty thousand events is what the free plan sells and what the landing page
 * says; sending fifty thousand through the wire to watch a banner appear would
 * make the drive minutes longer for nothing. So the PLAN is lowered instead of
 * the mechanism being bent: no test-only plan row joins the shipped catalog, no
 * environment variable teaches ingest a second way to decide "over quota", and
 * the code path the drive then exercises — `plans` → the workspace-state cache →
 * head sampling → the banner — is byte-identical to the one a real customer
 * crosses at fifty thousand.
 *
 * Exported because the drive asserts against this number and must not restate
 * it: the seeder writes it, the drive reads it, and there is one 300 in the
 * repository rather than two that can drift (S2.3 L3).
 */
export const EVIDENCE_FREE_QUOTA = 300;

/**
 * Which store this writes to, stated plainly: the DISPOSABLE compose Postgres.
 * It is an UPDATE with no undo — the seeder holds no previous value and would
 * have nothing honest to restore — so a stack that has run the drive carries a
 * 300-event free plan until `docker compose … down -v`. That is the same
 * posture the ClickHouse half already has (no mutation grant, start clean), and
 * it is why the drive's fixing values print the DSN it ran against.
 */
const LOWER_FREE_QUOTA_SQL = `UPDATE plans SET event_quota = $1 WHERE id = 'free'
  RETURNING id, name, event_quota, retention_days`;

async function lowerFreeQuota() {
  const client = new pg.Client({ connectionString: PG_DSN });
  await client.connect();
  try {
    const { rows } = await client.query(LOWER_FREE_QUOTA_SQL, [EVIDENCE_FREE_QUOTA]);
    // No row is a broken schema, not a workspace's state: `plans` is seeded by
    // 0005_metering.sql and both runtimes read their quota from it (D163), so a
    // catalog without a free row means the migration this drive assumes has not
    // run — and every assertion after this one would be about nothing.
    if (rows.length !== 1) {
      throw new Error("no 'free' row in plans — 0005_metering.sql seeds the catalog (D163)");
    }
    return rows[0];
  } finally {
    await client.end();
  }
}

// ----------------------------------------------------- the metrics seeding
/**
 * The S6.1 metrics fixture (D370), and the one thing it does differently from
 * everything above is the entire point of it: these rows go in through the
 * FRONT DOOR — an OTLP/JSON export POSTed to the real `/v1/metrics` with the
 * workspace's own key — never a direct ClickHouse insert (D115/D370). A
 * fixture written straight into `metric_points` would prove the query
 * contract and nothing at all about the receiver, the delta normalization or
 * the materialized views standing between an exporter and an answer.
 *
 * All three OTLP temperaments, in one export, under one resource:
 *   - a GAUGE, which passes through untouched;
 *   - a cumulative monotonic SUM and a cumulative HISTOGRAM, which are
 *     delta-normalized at ingest — and whose FIRST observation registers a
 *     baseline and emits NO row (D363 §1). That is why each of those carries
 *     THREE snapshots rather than one: the first buys the baseline, and the
 *     two after it are the deltas the 1m rollup merges into a known bucket.
 *
 * Nothing here can be undone either, but nothing here needs to be: the drive
 * points this at a workspace a signup created seconds earlier, and a second
 * run against the same one would be two more cumulative snapshots on a series
 * that already has a baseline — a different fixture, which is exactly what the
 * expectations printed below would then say.
 */

/** How far back the export is stamped: well inside the contract's 1h window of
 *  60 one-minute buckets, and far enough back that the minute it lands in is
 *  CLOSED — "the value in that bucket" against a minute still filling would be
 *  a race with the wall clock rather than a claim about the data. */
const METRICS_BUCKET_MS = Math.floor((now - 3 * 60_000) / 60_000) * 60_000;

/** One attribute beyond the resource's own `service.name`, so the catalog's
 *  attrKeys — and therefore the groupBy the UI offers from them — is more than
 *  a single key, and "attributes survived the merged-label-set path" (D375) is
 *  a claim about two of them. */
export const METRIC_ATTR_KEY = "deployment.environment";
const METRIC_ATTR_VALUE = "e2e";

const GAUGE_VALUE = 42;
/** Cumulative snapshots: the first registers, the two after it are 30 apiece,
 *  and both land in the same minute — 60 summed over that bucket. */
const SUM_SNAPSHOTS = [1000, 1030, 1060];
/** Cumulative snapshots whose DELTAS merge to the distribution T6 pinned
 *  against the real engine: counts [0,10,10,10,10,0] over bounds
 *  [0,10,20,30,40], h_sum/h_count 800/40. */
const HIST_BOUNDS = [0, 10, 20, 30, 40];
const HIST_SNAPSHOTS = [
  { counts: [0, 0, 0, 0, 0, 0], sum: 0, count: 0 },
  { counts: [0, 5, 5, 0, 0, 0], sum: 100, count: 10 },
  { counts: [0, 10, 10, 10, 10, 0], sum: 800, count: 40 },
];

/**
 * The three metric NAMES this leg emits for a label, carrying it the same way
 * every row above does (D135): two workspaces seeded from this one definition
 * are told apart by what they SAY, and a catalog listing the other tenant's
 * names would be saying so out loud. A function rather than three constants
 * for the same reason `dataset(label)` is one — the label is the caller's —
 * and the drive imports it so the page it opens names the metric the export
 * built, with no second spelling to drift.
 */
export const metricNames = (label) => ({
  gauge: `${label}.queue.depth`,
  sum: `${label}.requests.total`,
  histogram: `${label}.request.duration`,
});

const METRIC_UNITS = { gauge: "{item}", sum: "{request}", histogram: "ms" };

/**
 * One exactly-known answer per temperament, and where each comes from:
 *   - gauge/avg — the single point's own value;
 *   - sum/sum   — the deltas between consecutive snapshots, summed in one
 *                 minute, computed here from the snapshots themselves;
 *   - histogram/p90 — linear interpolation over the MERGED delta buckets:
 *     target 0.9 × 40 = 36 samples lands 6/10 of the way through the (30,40]
 *     bucket, so 30 + 0.6 × 10 = 36. Pinned rather than recomputed, because a
 *     quantile implementation in the fixture would be a second copy of the
 *     thing under test (T6 proves this same distribution against the engine).
 */
const METRIC_EXPECTED = {
  gauge: { agg: "avg", value: GAUGE_VALUE },
  sum: { agg: "sum", value: SUM_SNAPSHOTS.slice(1).reduce((total, v, i) => total + (v - SUM_SNAPSHOTS[i]), 0) },
  histogram: { agg: "p90", value: 36 },
};

/**
 * What this leg says it sent, in the shape `metrics-checks.ts` asserts against.
 * The SEEDER states it because the seeder is the only one that knows it — the
 * bucket and the last-seen minute are functions of when this ran — and the
 * drive passes the printed value straight through, so there is one definition
 * of the fixture's expected answers instead of two that can drift (S2.3 L3).
 */
export function metricsExpectations(label) {
  const names = metricNames(label);
  const at = new Date(METRICS_BUCKET_MS).toISOString();
  return ["gauge", "sum", "histogram"].map((type) => ({
    name: names[type],
    type,
    unit: METRIC_UNITS[type],
    /** The contract's ISO UTC minute — every point of this export lands in it. */
    lastSeen: `${at.slice(0, 16)}Z`,
    attrKeys: ["service.name", METRIC_ATTR_KEY],
    agg: METRIC_EXPECTED[type].agg,
    value: METRIC_EXPECTED[type].value,
    /** `MetricSeriesPoint.t`, which is "HH:MM" UTC. */
    bucket: at.slice(11, 16),
    groupBy: "service.name",
    group: `${label}-svc`,
  }));
}

/** The export itself. uint64 wire fields go as STRINGS: a nanosecond timestamp
 *  is past what a JS number holds exactly, and OTLP/JSON says so. */
function metricsExport(label) {
  const names = metricNames(label);
  const at = (second) => `${METRICS_BUCKET_MS + second * 1_000}000000`;
  /** An hour before the window, and CONSTANT across the snapshots: a changed
   *  start_time is the SDK-restart signal, and ingest would then read each raw
   *  value as the delta instead of the difference (D363 §1's reset rule). */
  const startTimeUnixNano = `${METRICS_BUCKET_MS - 3_600_000}000000`;
  const attributes = [{ key: METRIC_ATTR_KEY, value: { stringValue: METRIC_ATTR_VALUE } }];
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: `${label}-svc` } }] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: names.gauge,
                unit: METRIC_UNITS.gauge,
                gauge: { dataPoints: [{ attributes, asDouble: GAUGE_VALUE, timeUnixNano: at(1) }] },
              },
              {
                name: names.sum,
                unit: METRIC_UNITS.sum,
                sum: {
                  aggregationTemporality: 2, // AGGREGATION_TEMPORALITY_CUMULATIVE
                  isMonotonic: true,
                  dataPoints: SUM_SNAPSHOTS.map((value, i) => ({
                    attributes,
                    asDouble: value,
                    startTimeUnixNano,
                    timeUnixNano: at(i + 1),
                  })),
                },
              },
              {
                name: names.histogram,
                unit: METRIC_UNITS.histogram,
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: HIST_SNAPSHOTS.map((snapshot, i) => ({
                    attributes,
                    explicitBounds: HIST_BOUNDS,
                    bucketCounts: snapshot.counts.map(String),
                    sum: snapshot.sum,
                    count: String(snapshot.count),
                    startTimeUnixNano,
                    timeUnixNano: at(i + 1),
                  })),
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The key is REFUSED rather than defaulted, same posture as `--workspace` and
 * `--label`, and it is read from the ENVIRONMENT rather than argv for the
 * reason every secret in this stack is: `ps` publishes a command line to every
 * process on the box, and this is a live `ok_live_` key the drive's own hygiene
 * step then asserts reached nothing it printed or wrote.
 */
async function seedMetrics(label) {
  const token = process.env.SEED_METRICS_TOKEN;
  if (!token) {
    throw new Error(
      `SEED_METRICS_TOKEN is required for --leg metrics — the workspace's own key, in the environment. ${USAGE}`,
    );
  }
  const body = metricsExport(label);
  const res = await fetch(`${OTLP}/v1/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Anything but 200 is the receiver refusing this export, and every claim the
  // drive makes after it would be about a workspace nothing arrived in.
  if (res.status !== 200) {
    throw new Error(`POST ${OTLP}/v1/metrics answered ${res.status}: ${text.slice(0, 300)}`);
  }
  const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;
  return {
    endpoint: `${OTLP}/v1/metrics`,
    series_sent: metrics.length,
    points_sent: metrics.reduce((total, m) => total + (m.gauge ?? m.sum ?? m.histogram).dataPoints.length, 0),
  };
}

// Seeding runs only when this file is the program, and importing it for its
// constants must never write: the ingest user has no mutation grant, so a
// second insert cannot be undone without `down -v`, and duplicated rows would
// quietly inflate every count the evidence checks. Both guards are here because
// the first one alone was not enough — reading a constant with
// `node -e "import(process.argv[1])"` makes this module argv[1] too.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
const readingConstants = process.env.SEED_MODULE !== undefined;

if (invokedDirectly && !readingConstants && process.argv.includes("--lower-free-quota")) {
  console.log(JSON.stringify({ plan: await lowerFreeQuota() }, null, 2));
} else if (invokedDirectly && !readingConstants && legOf(process.argv) === "metrics") {
  const workspace = requiredArg(process.argv, "--workspace");
  const label = requiredArg(process.argv, "--label");
  // The token is in the environment and stays there: what this prints is what
  // it SENT, and the expectations the drive then asserts against.
  const sent = await seedMetrics(label);
  console.log(JSON.stringify({ workspace, label, ...sent, expectations: metricsExpectations(label) }, null, 2));
} else if (invokedDirectly && !readingConstants) {
  const workspace = requiredArg(process.argv, "--workspace");
  const label = requiredArg(process.argv, "--label");
  const { spans, logs } = dataset(label);
  const existing = await count(
    `SELECT count() FROM obstack.spans WHERE workspace_id = '${workspace}'`,
  );
  if (existing > 0 && process.env.FORCE !== "1") {
    throw new Error(
      `${workspace} already holds ${existing} span row(s). This seeder cannot delete (no mutation grant), ` +
        `so re-running would duplicate the dataset and inflate every count the evidence asserts. ` +
        `Start from clean volumes (docker compose --profile demo down -v), or set FORCE=1 deliberately.`,
    );
  }
  await insert("spans", spans, workspace);
  await insert("logs", logs, workspace);
  const distinctTraces = new Set(spans.map((s) => s.trace_id));
  if (distinctTraces.has("")) throw new Error("a span carries an empty trace_id — that is a P13-class phantom (D71(b))");
  console.log(
    JSON.stringify(
      {
        workspace,
        label,
        traces_seeded: distinctTraces.size,
        span_rows: spans.length,
        log_rows: logs.length,
        renderable_log_rows: logs.filter((l) => l.body !== "").length,
        prompt_trace: PROMPT_TRACE,
        log_trace: LOG_TRACE,
        carrier_trace: CARRIER_TRACE,
        empty_trace_id_spans: spans.filter((s) => s.trace_id === "").length,
      },
      null,
      2,
    ),
  );
}
