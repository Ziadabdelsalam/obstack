/**
 * The S2.3 exit-evidence dataset (T5).
 *
 * Writes a DEDICATED workspace straight into ClickHouse through the ingest
 * user, so the evidence run asserts against data whose exact shape is known
 * here rather than whatever a demo happens to emit. Everything it inserts is
 * printed as counts, and those counts are what the UI's "N of M" is checked
 * against — an independent denominator, which is also the phantom guard
 * (D71(b)): no span carries an empty trace_id, so no `trace_id=''` summary row
 * can exist to inflate a total.
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
 *   node deploy/compose/exit-seed.mjs
 */

const CH = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const USER = process.env.CLICKHOUSE_INGEST_USER ?? "obstack_ingest";
const PASSWORD = process.env.CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";
export const WORKSPACE = process.env.OBSTACK_WORKSPACE_ID ?? "ws_s23_exit";

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

function span(overrides) {
  return {
    workspace_id: WORKSPACE,
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
}

function log(overrides) {
  return {
    workspace_id: WORKSPACE,
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
}

// ---- spans: one api root each, plus an llm child on the two probe traces.
// Ages are 1 minute apart from 2 minutes back, so every trace is inside the 6h
// default window and the DESC order is total (no ties to hide a sort bug).
const spans = [];
for (let i = 0; i < TRACES; i++) {
  const msAgo = (i + 2) * 60_000;
  spans.push(
    span({
      trace_id: traceId(i),
      span_id: `s${i}-root`,
      start_time: chTime(msAgo),
      duration_ns: String((120 + i) * 1_000_000),
      status_code: i % 20 === 7 ? "error" : "ok",
      service: i % 3 === 0 ? "exit-gateway" : "exit-agent",
    }),
  );
}

/** The trace findable ONLY through the span-prompt leg of the search contract. */
export const PROMPT_TRACE = traceId(5);
spans.push(
  span({
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
    log({
      timestamp: chTime((i + 1) * 60_000),
      body: `exit bulk line ${i} handled request`,
      trace_id: i % 8 === 0 ? traceId(i % TRACES) : "",
    }),
  );
}

/** The trace findable ONLY through the log-body leg. */
export const LOG_TRACE = traceId(9);
logs.push(
  log({
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
  logs.push(log({ timestamp: chTime((i + 2) * 60_000), body: `exit db checkpoint ${i}`, k8s_pod: "exit-db-0" }));
}
// A D42 content-carrier row: non-empty prompt, EMPTY body. /app/logs must not
// render it, count it, or match it; the traces list must still find its trace.
export const CARRIER_TRACE = traceId(11);
logs.push(
  log({
    timestamp: chTime(13 * 60_000),
    trace_id: CARRIER_TRACE,
    body: "",
    prompt: `event-form prompt ${CARRIER_TOKEN}`,
    completion: "event-form completion",
    k8s_pod: "exit-carrier",
  }),
);

async function insert(table, rows) {
  const query = encodeURIComponent(`INSERT INTO obstack.${table} FORMAT JSONEachRow`);
  const res = await fetch(`${CH}/?user=${USER}&password=${PASSWORD}&query=${query}`, {
    method: "POST",
    body: rows.map((r) => JSON.stringify(r)).join("\n"),
  });
  if (!res.ok) throw new Error(`insert into ${table} failed: ${res.status} ${await res.text()}`);
}

async function count(sql) {
  const res = await fetch(`${CH}/?user=${USER}&password=${PASSWORD}`, { method: "POST", body: sql });
  return Number((await res.text()).trim());
}

// Seeding runs only when this file is the program, and importing it for its
// constants must never write: the ingest user has no mutation grant, so a
// second insert cannot be undone without `down -v`, and duplicated rows would
// quietly inflate every count the evidence checks. Both guards are here because
// the first one alone was not enough — reading a constant with
// `node -e "import(process.argv[1])"` makes this module argv[1] too.
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
const readingConstants = process.env.SEED_MODULE !== undefined;

if (invokedDirectly && !readingConstants) {
  const existing = await count(
    `SELECT count() FROM obstack.spans WHERE workspace_id = '${WORKSPACE}'`,
  );
  if (existing > 0 && process.env.FORCE !== "1") {
    throw new Error(
      `${WORKSPACE} already holds ${existing} span row(s). This seeder cannot delete (no mutation grant), ` +
        `so re-running would duplicate the dataset and inflate every count the evidence asserts. ` +
        `Start from clean volumes (docker compose --profile demo down -v), or set FORCE=1 deliberately.`,
    );
  }
  await insert("spans", spans);
  await insert("logs", logs);
  const distinctTraces = new Set(spans.map((s) => s.trace_id));
  if (distinctTraces.has("")) throw new Error("a span carries an empty trace_id — that is a P13-class phantom (D71(b))");
  console.log(
    JSON.stringify(
      {
        workspace: WORKSPACE,
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
