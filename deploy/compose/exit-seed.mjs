/**
 * The evidence dataset the `e2e` drive seeds (T5, extended by F8 and S3.3).
 *
 * TWO SEEDINGS LIVE HERE, one per store, and they are invoked separately
 * because they answer different questions. `--workspace/--label` writes the
 * ClickHouse telemetry fixture described below; `--lower-free-quota` writes the
 * single Postgres row the S3.3 metering step needs (D172) and touches nothing
 * else. See "the quota seeding" at the bottom of this file.
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
 *   node deploy/compose/exit-seed.mjs --lower-free-quota
 */

import pg from "pg";

const CH = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const USER = process.env.CLICKHOUSE_INGEST_USER ?? "obstack_ingest";
const PASSWORD = process.env.CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";
const PG_DSN =
  process.env.OBSTACK_POSTGRES_DSN ?? "postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack";

const USAGE =
  "usage: node deploy/compose/exit-seed.mjs --workspace <workspace_id> --label <label>\n" +
  "       node deploy/compose/exit-seed.mjs --lower-free-quota";

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
