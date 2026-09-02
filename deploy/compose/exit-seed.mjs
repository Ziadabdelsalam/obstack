/**
 * The evidence dataset the `e2e` drive seeds (T5, extended by F8 and S3.3).
 *
 * FIVE SEEDINGS LIVE HERE, and they are invoked separately because they answer
 * different questions. `--workspace/--label` writes the ClickHouse telemetry
 * fixture described below; `--lower-free-quota` writes the single Postgres row
 * the S3.3 metering step needs (D172) and touches nothing else; `--leg metrics`
 * sends the S6.1 metrics fixture through the product's OWN front door — an OTLP
 * export to the real `/v1/metrics`, never an insert (D370); `--leg dashboards`
 * writes the S6.3 dashboard row, the one fixture in this file with no front
 * door to go through (D424); `--leg k8s` sends the S6.4 kubelet_stats/
 * k8s_cluster fixture (D467) through that SAME front door as `--leg metrics` —
 * `/app/infra` reads `metric_points_1m` exactly the way `/app/explore` does, so
 * it has to be proven against rows that arrived the way a real DaemonSet's do,
 * not a direct insert. See "the quota seeding", "the metrics seeding", "the
 * dashboards seeding" and "the k8s metrics seeding" at the bottom.
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
 * S6.2 (D405) deepened the SPAN fixture — no new traces, no new log rows, no
 * tokens or cost — so the five surfaces wired that sprint have something of
 * their own to render: a `gateway → agent → tool` chain under every sixth root
 * (the only parent→child pairs whose two spans sit in different services, so
 * the only edges `/app/map` can draw), `enduser.id` on two residues of the root
 * spans (`/app/users`), and two error signatures on the roots that already
 * failed — one carrying digits that differ per trace, one carrying none, so
 * `/app/issues` shows exactly two groups if and only if it normalizes numbers
 * away. All three are label-derived like every other word here (D135).
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
 *   node deploy/compose/exit-seed.mjs --leg dashboards --workspace ws_1a2b3c --label zzalice
 *   SEED_METRICS_TOKEN=ok_live_… node deploy/compose/exit-seed.mjs --leg k8s --workspace ws_1a2b3c
 *   node deploy/compose/exit-seed.mjs --lower-free-quota
 */

import { randomBytes } from "node:crypto";
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
  "       node deploy/compose/exit-seed.mjs --leg dashboards --workspace <workspace_id> --label <label>\n" +
  "       node deploy/compose/exit-seed.mjs --leg k8s --workspace <workspace_id>\n" +
  "         (with SEED_METRICS_TOKEN=<that workspace's own ok_live_ key> in the environment)\n" +
  "       node deploy/compose/exit-seed.mjs --leg alerts --workspace <workspace_id> --label <label> --target <receiver url>\n" +
  "       node deploy/compose/exit-seed.mjs --leg slos --workspace <workspace_id> --label <label> [--target <receiver url>]\n" +
  "         (with --target: the measured pair on a channel; without: one objective on a workspace with no traces)\n" +
  "       node deploy/compose/exit-seed.mjs --lower-free-quota";

/** Which store this invocation writes to. Absent is the ClickHouse fixture, so
 *  the default invocation is exactly the one it always was. */
const LEGS = ["clickhouse", "metrics", "dashboards", "k8s", "alerts", "slos"];
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
    // The error message is CONTENT too (S6.2/D405): `/app/issues` renders it as
    // an issue's title, so it carries the label like every other rendered word
    // — and `labelled` leaves the empty default empty, so only spans that
    // actually failed say anything.
    status_message: labelled(row.status_message, label),
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
/** The trace carrying the one UNPRICED LLM span (D467/D461/T6) — alone in a
 * trace of its own, out of the TRACES loop's index range entirely, so it never
 * collides with a trace some other assertion already pins by id or by count. */
export const UNPRICED_TRACE = traceId(999);

/**
 * Every sixth trace gets the cross-service chain below — and the divisor is
 * load-bearing twice over. It is a multiple of 3, so a chained trace is always
 * one whose root is `exit-gateway` (`i % 3 === 0`), which is what makes the
 * chain a hop BETWEEN services; and it is 6 rather than 3, so half the gateway
 * traces keep no `exit-agent` span at all and `/app/traces?service=exit-agent`
 * still counts fewer traces than the workspace holds (D405 invariant 2).
 */
const CHAIN_EVERY = 6;

/**
 * The two error signatures the failing roots carry (D405). They differ in the
 * one way `/app/issues` must NOT split on — digits — and in the one way it
 * must: the words. `TIMEOUT_MESSAGE` is a function because every trace that
 * carries it carries a different number, so the seven of them collapse into
 * ONE issue only if the fingerprint really does normalize digits away (D399);
 * `DECLINED_MESSAGE` has no digits at all and is its own group.
 */
const timeoutMessage = (i) => `upstream timeout after ${(i + 1) * 13}ms`;
const DECLINED_MESSAGE = "payment declined at the processor";

/**
 * What those two signatures look like on `/app/issues`, exported so the drive
 * ASSERTS the words this file writes instead of restating them (S2.3 L3).
 * `timeoutPrefix` is the part of the timeout signature that survives
 * normalization intact — everything after it is the digits that collapse — so
 * finding it exactly once is finding the seven variants merged into one issue.
 * `declined` carries no digits and therefore renders whole, label included.
 */
export const errorSignatures = (label) => ({
  timeoutPrefix: "upstream timeout after",
  declined: labelled(DECLINED_MESSAGE, label),
});

/** The two people `/app/users` names for a label, in the order they are seeded. */
export const endUserIds = (label) => [`${label}-user-1`, `${label}-user-2`];

/**
 * The chain's services, root first. Exported for the same reason: `/app/map`
 * draws one edge per hop between them, and `/app/services` lists all three.
 */
export const CHAIN_SERVICES = ["exit-gateway", "exit-agent", "exit-tool"];
const [GATEWAY_SERVICE, AGENT_SERVICE, TOOL_SERVICE] = CHAIN_SERVICES;

/**
 * `enduser.id` on a SUBSET of the root spans, two users per label (D405).
 *
 * The id is CONTENT — `/app/users` renders it as the person's name — so it
 * derives from the label like every other word this fixture writes (D135),
 * while ids, services, pods and counts stay identical between two seedings
 * (D115). Two residues out of five, so most roots carry no identity at all and
 * the surface's population is a real subset; `i % 5 === 2` is also exactly the
 * residue the failing roots (`i % 20 === 7`) fall in, which is what gives
 * user-1 failures to be at risk over and user-2 none.
 */
function endUserAttributes(i, label) {
  const [first, second] = endUserIds(label);
  if (i % 5 === 2) return { "enduser.id": first };
  if (i % 5 === 3) return { "enduser.id": second };
  return {};
}

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
    const failing = i % 20 === 7;
    const gateway = i % 3 === 0;
    spans.push(
      span(label, {
        trace_id: traceId(i),
        span_id: `s${i}-root`,
        start_time: chTime(msAgo),
        duration_ns: String((120 + i) * 1_000_000),
        status_code: failing ? "error" : "ok",
        // Which signature a failure carries follows the service it failed in,
        // so each of the two groups `/app/issues` shows is one service's.
        status_message: failing ? (gateway ? DECLINED_MESSAGE : timeoutMessage(i)) : "",
        service: gateway ? GATEWAY_SERVICE : AGENT_SERVICE,
        attributes: endUserAttributes(i, label),
      }),
    );
  }

  // ---- the cross-service chain (D405): gateway → agent → tool, hung under
  // every sixth root. These are the only parent→child pairs in the fixture
  // whose two spans sit in DIFFERENT services, so they are the only edges
  // `/app/map` can draw — and both sides are stored, which is what the surface
  // says an edge requires. They carry no tokens, no cost and no new trace id:
  // the chain deepens traces that already exist rather than adding any.
  for (let i = 0; i < TRACES; i += CHAIN_EVERY) {
    const msAgo = (i + 2) * 60_000;
    spans.push(
      span(label, {
        trace_id: traceId(i),
        span_id: `s${i}-agent`,
        parent_span_id: `s${i}-root`,
        name: "agent.plan",
        kind: "client",
        layer: "agent",
        service: AGENT_SERVICE,
        start_time: chTime(msAgo - 1_000),
        duration_ns: String(60 * 1_000_000),
      }),
      span(label, {
        trace_id: traceId(i),
        span_id: `s${i}-tool`,
        parent_span_id: `s${i}-agent`,
        name: "tool.lookup",
        kind: "client",
        layer: "tool",
        service: TOOL_SERVICE,
        start_time: chTime(msAgo - 2_000),
        duration_ns: String(20 * 1_000_000),
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

  // ---- D467/D461/T6: ONE unpriced LLM span — a custom fine-tune `prices.json`
  // has no row for, so ingest stamps `cost_usd: 0` on it the same way it would
  // stamp a genuinely free call, which is the honesty hazard the costs surface
  // must name separately. Alone in a trace of its own rather than hung under
  // PROMPT_TRACE or the chain: this span's whole point is to be counted and
  // priced by itself, and joining a trace whose span count or shape another
  // assertion already pins would put this fixture at risk of the very checks
  // it has to leave green (T4's placement constraint).
  spans.push(
    span(label, {
      trace_id: UNPRICED_TRACE,
      span_id: "s999-llm",
      name: "chat.completion",
      layer: "llm",
      service: AGENT_SERVICE,
      start_time: chTime(90_000),
      duration_ns: String(45 * 1_000_000),
      gen_ai_system: "custom",
      gen_ai_request_model: "exit-custom-ft",
      gen_ai_response_model: "",
      input_tokens: 12,
      output_tokens: 3,
      cost_usd: 0,
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
 * points this at a workspace a signup created seconds earlier, and never
 * re-runs the leg against it — fresh strangers every run. A second run by
 * hand would carry a new `startTimeUnixNano` and so hit the cumulative-reset
 * path (D363 §1's reset rule) rather than continue the same accumulation; the
 * expectations printed below are static, so what they'd then say — the sum's
 * 60, among them — would be a lie about that workspace. No guard is added
 * here on purpose: a ClickHouse read in a leg that otherwise needs nothing
 * but a token would be machinery built only for that hand-run case.
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

// -------------------------------------------------------- the k8s seeding
/**
 * The S6.4 `/app/infra` fixture (D467), through the same front door as the
 * metrics leg beside it — an OTLP export to the real `/v1/metrics` — and for
 * the same reason: a page that reads `metric_points_1m` proves nothing about
 * the receiver, the resource-attribute merge (D375) or the D457 completeness
 * rule if the rows it reads were inserted straight into ClickHouse.
 *
 * NO label anywhere in this leg. Every other seeding carries the label on its
 * CONTENT (D135) because a person reads that content; nothing here is content
 * — a node name, a pod name and a namespace are the same words whichever
 * workspace they land in, exactly the way two clusters running the same demo
 * Deployment would both be called `exit-app-1`. That is also why `exit-app-1`
 * is spelled identically to the pod the logs/spans legs already use (D467) —
 * the pod table's deep link to `/app/logs?pod=exit-app-1` is a real join, not
 * a coincidence of two fixtures agreeing by chance.
 *
 * GAUGES only, one point per series unless stated: D450 whitelisted no
 * cumulative `.time` counters for this leg, so there is no delta/reset path to
 * exercise the way the metrics leg's sum/histogram do (D363 §1 does not apply
 * here at all).
 */

/** Verbatim copy of `apps/web/src/lib/infra-types.ts`'s `KUBELET_METRICS`
 *  (D450/D456) — copied, not retyped, so a rename there cannot silently drift
 *  this fixture out from under the whitelist it targets. Order matches. */
const KUBELET_METRICS = [
  "k8s.node.cpu.usage",
  "k8s.node.memory.working_set",
  "k8s.node.memory.available",
  "k8s.pod.cpu.usage",
  "k8s.pod.memory.working_set",
  "container.cpu.usage",
  "container.memory.working_set",
];
const [
  M_NODE_CPU_USAGE,
  M_NODE_MEM_WORKING_SET,
  M_NODE_MEM_AVAILABLE,
  M_POD_CPU_USAGE,
  M_POD_MEM_WORKING_SET,
  M_CONTAINER_CPU_USAGE,
  M_CONTAINER_MEM_WORKING_SET,
] = KUBELET_METRICS;

/** Verbatim copy of `CLUSTER_METRICS` (D450/D456), same rationale. */
const CLUSTER_METRICS = [
  "k8s.node.condition_ready",
  "k8s.node.condition_memory_pressure",
  "k8s.node.allocatable_cpu",
  "k8s.node.allocatable_memory",
  "k8s.pod.phase",
  "k8s.container.restarts",
  "k8s.container.cpu_request",
  "k8s.container.cpu_limit",
  "k8s.container.memory_request",
  "k8s.container.memory_limit",
];
const [
  M_NODE_CONDITION_READY,
  M_NODE_CONDITION_MEMORY_PRESSURE,
  M_NODE_ALLOCATABLE_CPU,
  M_NODE_ALLOCATABLE_MEMORY,
  M_POD_PHASE,
  M_CONTAINER_RESTARTS,
  M_CONTAINER_CPU_REQUEST,
  M_CONTAINER_CPU_LIMIT,
  M_CONTAINER_MEM_REQUEST,
  M_CONTAINER_MEM_LIMIT,
] = CLUSTER_METRICS;

/** "Fresh" reuses the metrics leg's own three-minutes-back convention
 *  (D467's default): the same bucket is CLOSED for the same reason there. */
const K8S_FRESH_MS = METRICS_BUCKET_MS;
/** `exit-app-1`'s oversized rec needs `INFRA_RECS_MIN_OBSERVED_HOURS` (12h) of
 *  observation inside the 24h recs window (D458) — a second point 13h back
 *  clears it (D467). */
const K8S_OBSERVED_MS = now - 13 * 60 * 60_000;
/** Outside `INFRA_STALE_MINUTES` (10m, D456): `exit-stale-1` exists in the
 *  store and nowhere on the page (D467). */
const K8S_STALE_MS = now - 30 * 60_000;

/** Two nodes (D467). `ready`/`memoryPressure` are the raw `k8s.node.condition_*`
 *  encoding (1/0/-1) `lib/infra-types.ts` decodes, not booleans. */
const K8S_NODES = [
  {
    name: "exit-node",
    cpuUsage: 1.2,
    memWorkingSet: 6442450944,
    memAvailable: 10737418240,
    cpuAllocatable: 4,
    memAllocatable: 17179869184,
    ready: 1,
    memoryPressure: 0,
  },
  {
    name: "exit-node-2",
    cpuUsage: 0.4,
    memWorkingSet: 2147483648,
    memAvailable: 6442450944,
    cpuAllocatable: 2,
    memAllocatable: 8589934592,
    ready: 1,
    memoryPressure: 0,
  },
];

/**
 * Five pods in `exit-ns`, one container each (D467). Fields are OPTIONAL on
 * purpose: a real kubelet or cluster receiver only emits the metrics a pod's
 * own shape actually produces — `exit-kubelet-only-1` never got requests or
 * limits from the cluster collector, `exit-worker-1`/`exit-crash-1` were never
 * given resource REQUESTS — so a field this object omits is a metric this leg
 * never sends, the same way it would be absent on the wire. `stale: true` is
 * the one pod stamped at `K8S_STALE_MS` instead of `K8S_FRESH_MS`.
 */
const K8S_PODS = [
  {
    // memory-limit-oversized: 107374182 / 536870912 ≈ 20% (D467/D458).
    name: "exit-app-1",
    node: "exit-node",
    container: "app",
    cpuUsage: 0.1,
    memWorkingSet: 107374182,
    memWorkingSetObservedAt: K8S_OBSERVED_MS,
    cpuLimit: 0.5,
    cpuRequest: 0.25,
    memLimit: 536870912,
    memRequest: 268435456,
    restarts: 0,
    phase: 2, // running
  },
  {
    // memory-near-limit: 255013683 / 268435456 ≈ 95%; cpu-near-limit: 0.9/1 = 90%.
    name: "exit-worker-1",
    node: "exit-node-2",
    container: "worker",
    cpuUsage: 0.9,
    memWorkingSet: 255013683,
    cpuLimit: 1,
    memLimit: 268435456,
    restarts: 0,
    phase: 2, // running
  },
  {
    // ONE fresh point ⇒ observedHours < 12 ⇒ NO oversized rec despite the ratio.
    name: "exit-crash-1",
    node: "exit-node-2",
    container: "app",
    cpuUsage: 0,
    memWorkingSet: 10485760,
    cpuLimit: 0.2,
    memLimit: 134217728,
    restarts: 5,
    phase: 1, // pending
  },
  {
    // kubelet_stats names only ⇒ no phase/restarts/limits ⇒ `—` cells (D457).
    name: "exit-kubelet-only-1",
    node: "exit-node",
    container: "app",
    cpuUsage: 0.05,
    memWorkingSet: 50_000_000,
  },
  {
    // Every point at K8S_STALE_MS ⇒ ABSENT from the page (D456's 10m rule).
    name: "exit-stale-1",
    node: "exit-node",
    container: "app",
    cpuUsage: 0.1,
    memWorkingSet: 50_000_000,
    cpuLimit: 0.5,
    memLimit: 200_000_000,
    restarts: 0,
    phase: 2, // running
    stale: true,
  },
];

/** uint64 wire fields go as STRINGS, same reason `metricsExport`'s `at` does. */
const k8sNanos = (ms) => `${ms}000000`;
const k8sAttr = (key, value) => ({ key, value: { stringValue: value } });

/** One or more points on a gauge. NO datapoint attributes: D467's series are
 *  RESOURCE-scoped, the way kubelet_stats/k8s_cluster actually emit them. */
const k8sGauge = (name, unit, points) => ({
  name,
  unit,
  gauge: { dataPoints: points.map(({ value, timeMs }) => ({ asDouble: value, timeUnixNano: k8sNanos(timeMs) })) },
});
const k8sPoint = (value, timeMs) => [{ value, timeMs }];
const k8sResource = (attributes, metrics) => ({ resource: { attributes }, scopeMetrics: [{ metrics }] });

/** A node's seven kubelet_stats + k8s_cluster gauges, resource attrs = just
 *  `k8s.node.name` (D467 — no `service.name`, no uid). */
function k8sNodeResourceMetrics(node) {
  const at = (value) => k8sPoint(value, K8S_FRESH_MS);
  return k8sResource([k8sAttr("k8s.node.name", node.name)], [
    k8sGauge(M_NODE_CPU_USAGE, "{cpu}", at(node.cpuUsage)),
    k8sGauge(M_NODE_MEM_WORKING_SET, "By", at(node.memWorkingSet)),
    k8sGauge(M_NODE_MEM_AVAILABLE, "By", at(node.memAvailable)),
    k8sGauge(M_NODE_CONDITION_READY, "1", at(node.ready)),
    k8sGauge(M_NODE_CONDITION_MEMORY_PRESSURE, "1", at(node.memoryPressure)),
    k8sGauge(M_NODE_ALLOCATABLE_CPU, "{cpu}", at(node.cpuAllocatable)),
    k8sGauge(M_NODE_ALLOCATABLE_MEMORY, "By", at(node.memAllocatable)),
  ]);
}

/**
 * A pod's two resources (D467): the POD series (`k8s.namespace.name`,
 * `k8s.pod.name`, `k8s.node.name`) and the CONTAINER series (those three plus
 * `k8s.container.name`). `container.memory.working_set` is the one metric that
 * can carry TWO points (`exit-app-1`'s `memWorkingSetObservedAt`); everything
 * else is the pod's single fresh (or stale) point.
 */
function k8sPodResourceMetrics(pod) {
  const freshAt = pod.stale ? K8S_STALE_MS : K8S_FRESH_MS;
  const at = (value) => k8sPoint(value, freshAt);
  const podAttrs = [
    k8sAttr("k8s.namespace.name", "exit-ns"),
    k8sAttr("k8s.pod.name", pod.name),
    k8sAttr("k8s.node.name", pod.node),
  ];
  const containerAttrs = [...podAttrs, k8sAttr("k8s.container.name", pod.container)];

  const podMetrics = [
    k8sGauge(M_POD_CPU_USAGE, "{cpu}", at(pod.cpuUsage)),
    k8sGauge(M_POD_MEM_WORKING_SET, "By", at(pod.memWorkingSet)),
  ];
  if (pod.phase !== undefined) podMetrics.push(k8sGauge(M_POD_PHASE, "1", at(pod.phase)));

  const workingSetPoints = pod.memWorkingSetObservedAt
    ? [
        { value: pod.memWorkingSet, timeMs: pod.memWorkingSetObservedAt },
        { value: pod.memWorkingSet, timeMs: freshAt },
      ]
    : at(pod.memWorkingSet);
  const containerMetrics = [
    k8sGauge(M_CONTAINER_CPU_USAGE, "{cpu}", at(pod.cpuUsage)),
    k8sGauge(M_CONTAINER_MEM_WORKING_SET, "By", workingSetPoints),
  ];
  if (pod.restarts !== undefined) containerMetrics.push(k8sGauge(M_CONTAINER_RESTARTS, "1", at(pod.restarts)));
  if (pod.cpuLimit !== undefined) containerMetrics.push(k8sGauge(M_CONTAINER_CPU_LIMIT, "{cpu}", at(pod.cpuLimit)));
  if (pod.cpuRequest !== undefined)
    containerMetrics.push(k8sGauge(M_CONTAINER_CPU_REQUEST, "{cpu}", at(pod.cpuRequest)));
  if (pod.memLimit !== undefined) containerMetrics.push(k8sGauge(M_CONTAINER_MEM_LIMIT, "By", at(pod.memLimit)));
  if (pod.memRequest !== undefined)
    containerMetrics.push(k8sGauge(M_CONTAINER_MEM_REQUEST, "By", at(pod.memRequest)));

  return [k8sResource(podAttrs, podMetrics), k8sResource(containerAttrs, containerMetrics)];
}

/** The export itself: one `resourceMetrics` entry per node, per pod and per
 *  container (D467's "resource-scoped series"). */
function k8sExport() {
  return {
    resourceMetrics: [
      ...K8S_NODES.map(k8sNodeResourceMetrics),
      ...K8S_PODS.flatMap(k8sPodResourceMetrics),
    ],
  };
}

/**
 * What this leg says it sent, in the shape the drive reads (S2.3 L3) — no
 * second spelling of "20%" or the pod names to drift from the fixture above.
 * Computed from `K8S_NODES`/`K8S_PODS`, not restated by hand.
 */
const freshK8sPods = K8S_PODS.filter((p) => !p.stale);
const oversizedPod = K8S_PODS.find((p) => p.name === "exit-app-1");
const nearLimitPod = K8S_PODS.find((p) => p.name === "exit-worker-1");
const crashPod = K8S_PODS.find((p) => p.name === "exit-crash-1");
export const k8sExpectations = {
  nodeNames: K8S_NODES.map((n) => n.name),
  podNames: freshK8sPods.map((p) => p.name),
  freshPodCount: freshK8sPods.length,
  header: `${K8S_NODES.length} nodes · ${freshK8sPods.length} pods`,
  stalePodName: K8S_PODS.find((p) => p.stale).name,
  crashPodName: crashPod.name,
  /** D469's arm reads the restart count as text — from the fixture, not retyped. */
  crashRestarts: crashPod.restarts,
  kubeletOnlyPodName: "exit-kubelet-only-1",
  oversizedPodName: oversizedPod.name,
  oversizedPct: Math.round((oversizedPod.memWorkingSet / oversizedPod.memLimit) * 100),
  memoryNearLimitPodName: nearLimitPod.name,
  memoryNearLimitPct: Math.round((nearLimitPod.memWorkingSet / nearLimitPod.memLimit) * 100),
  cpuNearLimitPct: Math.round((nearLimitPod.cpuUsage / nearLimitPod.cpuLimit) * 100),
};

/** Same posture as `seedMetrics`: the key travels in the environment, never
 *  argv, and this leg needs no `--label` — nothing it sends is content (see
 *  the section header above). */
async function seedK8s() {
  const token = process.env.SEED_METRICS_TOKEN;
  if (!token) {
    throw new Error(`SEED_METRICS_TOKEN is required for --leg k8s — the workspace's own key, in the environment. ${USAGE}`);
  }
  const body = k8sExport();
  const res = await fetch(`${OTLP}/v1/metrics`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new Error(`POST ${OTLP}/v1/metrics answered ${res.status}: ${text.slice(0, 300)}`);
  }
  const allMetrics = body.resourceMetrics.flatMap((rm) => rm.scopeMetrics[0].metrics);
  return {
    endpoint: `${OTLP}/v1/metrics`,
    resources_sent: body.resourceMetrics.length,
    series_sent: allMetrics.length,
    points_sent: allMetrics.reduce((total, m) => total + m.gauge.dataPoints.length, 0),
  };
}

// -------------------------------------------------- the dashboards seeding
/**
 * The S6.3 dashboards fixture (D424/D426), and what it does differently from
 * the metrics leg beside it is forced rather than chosen: a dashboard is a row
 * somebody CREATES IN THE UI, and no exporter, no OTLP endpoint and no API can
 * put one there. There is no front door to prefer, so this leg writes the row
 * with the app's own shape — `dash_<16 hex>`, `wdg_<16 hex>`, `widgets` exactly
 * `lib/dashboard-types.ts`'s `DashboardWidget[]` (D437) — straight into the
 * DISPOSABLE compose Postgres, on the `--lower-free-quota` posture.
 *
 * It runs AFTER the metrics leg and depends on it: every widget names one of
 * the three metrics that export sent, by the same `metricNames(label)` the
 * drive reads, and groups by `service.name`, the resource attribute it carried.
 * A dashboard over metrics that never arrived would render four honest empty
 * cards and prove nothing about the fold (D427).
 *
 * Nothing here can be undone, and nothing here needs a guard against a second
 * run: `UNIQUE (workspace_id, name)` is the guard, and Postgres raising 23505
 * is a clearer refusal than a SELECT this file could run first.
 */

/** The name the row carries — its identity inside the workspace (0009's UNIQUE). */
export const DASHBOARD_NAME = "Exit dashboard";

/** The ids the app itself mints (D116/D437), minted the same way here. */
const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;

/**
 * ONE dashboard's four widgets, one per kind (D426's `WIDGET_KINDS`), so the
 * drive sees every renderer over data whose exact answer is known:
 *   - stat, `last` on the gauge — the single point's own value, captioned
 *     `latest · as of {t} · last 1h` (D427);
 *   - timeseries, `avg` on that same gauge;
 *   - top-n and table, `sum` on the cumulative sum grouped by `service.name` —
 *     the one group the export's resource named, captioned
 *     `sum · last 1h · {n} of {N} buckets had data`.
 *
 * Exactly ONE is pinned (D425), which is what makes the overview's
 * `pinned from your dashboards · 1` a number about this fixture. There is no
 * watch row and no reserved dashboard to seed: the overview is a VIEW over that
 * flag, never a row of its own.
 *
 * The TITLES carry the label the way every other word this seeder writes does
 * (D135) — two workspaces seeded from this one definition are told apart by
 * what their dashboards say — and they are exported because the drive asserts
 * the titles it opens the page on and must not spell them a second time
 * (S2.3 L3). Each is distinguishable from the others as a SUBSTRING too: the
 * drive slices one card out of the page by the title above it.
 */
export function dashboardWidgets(label) {
  const names = metricNames(label);
  return [
    {
      title: `${label} depth right now`,
      kind: "stat",
      metric: names.gauge,
      type: "gauge",
      agg: "last",
      range: "1h",
      groupBy: null,
      pinned: true,
    },
    {
      title: `${label} depth over the hour`,
      kind: "timeseries",
      metric: names.gauge,
      type: "gauge",
      agg: "avg",
      range: "1h",
      groupBy: null,
      pinned: false,
    },
    {
      title: `${label} requests by service`,
      kind: "topn",
      metric: names.sum,
      type: "sum",
      agg: "sum",
      range: "1h",
      groupBy: "service.name",
      pinned: false,
    },
    {
      title: `${label} requests, tabulated`,
      kind: "table",
      metric: names.sum,
      type: "sum",
      agg: "sum",
      range: "1h",
      groupBy: "service.name",
      pinned: false,
    },
  ];
}

// ----------------------------------------------------- the alerts seeding
/**
 * The S7.1 alerts fixture. Channels and rules are UI-created rows the same
 * way dashboards are — no exporter, no OTLP endpoint, no API can put one
 * there — so this leg writes them in the app's own shape (`chan_`/`rule_`
 * ids, condition exactly `lib/alert-types.ts`'s structured form) straight
 * into the DISPOSABLE compose Postgres, the dashboards-leg precedent above.
 *
 * What stays REAL and unseeded is everything the sprint exists to prove: the
 * rules land with `state='ok'` and `next_eval_at=now()`, and it is T4's
 * evaluator inside the ingest binary that claims them, reads the metrics the
 * `--leg metrics` export actually sent, crosses the threshold, writes the
 * events, and delivers them — one to the drive's own receiver (`--target`),
 * one to a channel whose host does not resolve, so BOTH delivery truths are
 * facts the feed must state (D485/D13).
 *
 * The condition rides the gauge the metrics leg exports (value 42, sent
 * minutes before this leg runs): `avg > 40 over 15m` is a crossing by
 * construction, on data that went through the front door.
 */

export const ALERT_LIVE_CHANNEL = "drive webhook";
export const ALERT_DEAD_CHANNEL = "dead webhook";
export const ALERT_LIVE_RULE = "Exit gauge threshold";
export const ALERT_DEAD_RULE = "Exit dead-letter proof";
/** The unresolvable host: RFC 2606 reserves .invalid, so no resolver answers. */
export const ALERT_DEAD_TARGET = "http://alerts-dead.invalid/hook";

/** The one condition, from the seeder's own metric names (S2.3 L3). */
export const alertCondition = (label) => ({
  source: "metric",
  metric: metricNames(label).gauge,
  type: "gauge",
  agg: "avg",
  window: "15m",
  op: ">",
  threshold: 40,
  filters: {},
});

const INSERT_CHANNEL_SQL = `
  INSERT INTO notification_channels (workspace_id, id, name, kind, target)
       VALUES ($1, $2, $3, 'webhook', $4)
    RETURNING id, name`;

const INSERT_RULE_SQL = `
  INSERT INTO alert_rules (workspace_id, id, name, condition, severity, channel_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
    RETURNING id, name, state, next_eval_at <= now() AS due`;

async function seedAlerts(workspace, label, target) {
  const condition = alertCondition(label);
  const client = new pg.Client({ connectionString: PG_DSN });
  await client.connect();
  try {
    const channel = async (name, url) =>
      (await client.query(INSERT_CHANNEL_SQL, [workspace, newId("chan"), name, url])).rows[0];
    const rule = async (name, severity, channelId) =>
      (
        await client.query(INSERT_RULE_SQL, [
          workspace,
          newId("rule"),
          name,
          JSON.stringify(condition),
          severity,
          channelId,
        ])
      ).rows[0];

    const live = await channel(ALERT_LIVE_CHANNEL, target);
    const dead = await channel(ALERT_DEAD_CHANNEL, ALERT_DEAD_TARGET);
    // The RED half of this leg's proof (S2.0 L1): withholding the RULES —
    // channels land, nothing can fire — must fail the three downstream drive
    // assertions and never this seeder's own status. Proven 2026-09-02:
    // 243/3, exactly the event/delivery/receiver trio red. Not for CI.
    if (process.env.RED_WITHHOLD_RULES) return { condition, liveRule: null, deadRule: null };
    return {
      condition,
      liveRule: await rule(ALERT_LIVE_RULE, "critical", live.id),
      deadRule: await rule(ALERT_DEAD_RULE, "warning", dead.id),
    };
  } finally {
    await client.end();
  }
}

/**
 * The S7.3 SLO fixture (packet §5.3). SLOs are UI-created rows like rules, so
 * this leg writes them in the app's own shape (`slo_` ids, the indicator
 * exactly `lib/slo-types.ts`'s structured form, target as the NUMERIC the DDL
 * holds) straight into the DISPOSABLE compose Postgres.
 *
 * What stays REAL and unseeded is everything the sprint exists to prove: the
 * rows land in the honest `no-data` state with `next_eval_at = now()`, and it
 * is the ingest binary's evaluator (T4, on the S7.1 ticker) that claims them,
 * reads the traces the clickhouse leg seeded through `trace_summaries`,
 * computes attainment and budget, writes the status, and — for the one with a
 * channel — emits the breach through the S7.1 deliverer to the drive's own
 * receiver (`--target`).
 *
 * Three objectives, each a different truth by construction:
 *   - availability at 99.99% over 7d, on the channel: the seeded dataset fails
 *     one trace in twenty, so this is BREACHED and delivered;
 *   - latency at 50% under ten minutes over 30d, NO channel: every seeded
 *     trace is milliseconds long, so this is HEALTHY, silent (D511) — and on a
 *     free workspace the 30d window renders the D507 clip note;
 *   - (without --target) availability scoped to a service the workspace's
 *     traces never name: NO DATA, never a number (D508) — on a workspace that
 *     HAS traces, which is the sharper proof: no-data is per objective, and an
 *     empty window is not a measured 100%.
 */

export const SLO_CHANNEL = "slo webhook";
export const SLO_AVAILABILITY = "Exit availability objective";
export const SLO_AVAILABILITY_TARGET = 99.99;
export const SLO_AVAILABILITY_WINDOW = "7d";
export const SLO_LATENCY = "Exit latency objective";
export const SLO_LATENCY_TARGET = 50;
export const SLO_LATENCY_THRESHOLD_MS = 600000;
export const SLO_LATENCY_WINDOW = "30d";
export const SLO_EMPTY = "Exit empty objective";
/** A service no seeded span names (the chain is exit-gateway/agent/tool). */
export const SLO_EMPTY_SERVICE = "exit-nothing";

const INSERT_SLO_SQL = `
  INSERT INTO slos (workspace_id, id, name, indicator, target, eval_window, channel_id)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
    RETURNING id, name, status, next_eval_at <= now() AS due`;

async function seedSlos(workspace, target) {
  const client = new pg.Client({ connectionString: PG_DSN });
  await client.connect();
  try {
    const slo = async (name, indicator, targetPct, window, channelId) =>
      (
        await client.query(INSERT_SLO_SQL, [
          workspace,
          newId("slo"),
          name,
          JSON.stringify(indicator),
          targetPct,
          window,
          channelId,
        ])
      ).rows[0];

    // The RED half of this leg's proof (S2.0 L1): withholding the SLO rows —
    // the channel lands, nothing is measured — must fail the page, feed and
    // receiver assertions downstream and never this seeder's own status.
    const withheld = Boolean(process.env.RED_WITHHOLD_SLOS);

    if (target === null) {
      // The empty objective: one SLO, no channel, scoped to a service with no traces.
      return { channel: null, slos: withheld ? [] : [await slo(SLO_EMPTY, { kind: "availability", service: SLO_EMPTY_SERVICE }, SLO_AVAILABILITY_TARGET, SLO_AVAILABILITY_WINDOW, null)] };
    }
    const channel = (await client.query(INSERT_CHANNEL_SQL, [workspace, newId("chan"), SLO_CHANNEL, target])).rows[0];
    if (withheld) return { channel, slos: [] };
    return {
      channel,
      slos: [
        await slo(SLO_AVAILABILITY, { kind: "availability", service: null }, SLO_AVAILABILITY_TARGET, SLO_AVAILABILITY_WINDOW, channel.id),
        await slo(SLO_LATENCY, { kind: "latency", service: null, thresholdMs: SLO_LATENCY_THRESHOLD_MS }, SLO_LATENCY_TARGET, SLO_LATENCY_WINDOW, null),
      ],
    };
  } finally {
    await client.end();
  }
}

/**
 * The app's own column list, with `widgets` BOUND rather than interpolated: the
 * array carries a label the caller chose, and pasting it into statement text
 * would make this the one place in this file where that label could end a
 * statement. What comes back is what Postgres stored, counted from the stored
 * array — never from the one this process built.
 */
const INSERT_DASHBOARD_SQL = `
  INSERT INTO dashboards (workspace_id, id, name, widgets)
       VALUES ($1, $2, $3, $4::jsonb)
    RETURNING id, name, jsonb_array_length(widgets) AS widgets,
              (SELECT count(*)::int FROM jsonb_array_elements(widgets) w
                WHERE (w ->> 'pinned')::boolean IS TRUE) AS pinned`;

async function seedDashboard(workspace, label) {
  const widgets = dashboardWidgets(label).map((w) => ({ id: newId("wdg"), ...w }));
  const client = new pg.Client({ connectionString: PG_DSN });
  await client.connect();
  try {
    const { rows } = await client.query(INSERT_DASHBOARD_SQL, [
      workspace,
      newId("dash"),
      DASHBOARD_NAME,
      JSON.stringify(widgets),
    ]);
    return { ...rows[0], titles: widgets.map((w) => w.title) };
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
} else if (invokedDirectly && !readingConstants && legOf(process.argv) === "dashboards") {
  const workspace = requiredArg(process.argv, "--workspace");
  const label = requiredArg(process.argv, "--label");
  console.log(JSON.stringify({ workspace, label, dashboard: await seedDashboard(workspace, label) }, null, 2));
} else if (invokedDirectly && !readingConstants && legOf(process.argv) === "metrics") {
  const workspace = requiredArg(process.argv, "--workspace");
  const label = requiredArg(process.argv, "--label");
  // The token is in the environment and stays there: what this prints is what
  // it SENT, and the expectations the drive then asserts against.
  const sent = await seedMetrics(label);
  console.log(JSON.stringify({ workspace, label, ...sent, expectations: metricsExpectations(label) }, null, 2));
} else if (invokedDirectly && !readingConstants && legOf(process.argv) === "alerts") {
  const workspace = requiredArg(process.argv, "--workspace");
  const label = requiredArg(process.argv, "--label");
  const target = requiredArg(process.argv, "--target");
  console.log(JSON.stringify({ workspace, label, alerts: await seedAlerts(workspace, label, target) }, null, 2));
} else if (invokedDirectly && !readingConstants && legOf(process.argv) === "slos") {
  const workspace = requiredArg(process.argv, "--workspace");
  const label = requiredArg(process.argv, "--label");
  const at = process.argv.indexOf("--target");
  const target = at === -1 ? null : process.argv[at + 1];
  console.log(JSON.stringify({ workspace, label, slos: await seedSlos(workspace, target) }, null, 2));
} else if (invokedDirectly && !readingConstants && legOf(process.argv) === "k8s") {
  // No `--label`: nothing this leg sends is content (see the section header).
  const workspace = requiredArg(process.argv, "--workspace");
  const sent = await seedK8s();
  console.log(JSON.stringify({ workspace, ...sent, expectations: k8sExpectations }, null, 2));
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
        // The S6.2 additions, counted the same way everything else here is: from
        // the rows that were actually built, never from the rule that built them.
        chained_traces: new Set(spans.filter((s) => s.service === TOOL_SERVICE).map((s) => s.trace_id)).size,
        end_user_ids: endUserIds(label),
        end_user_root_spans: spans.filter((s) => s.attributes["enduser.id"] !== undefined).length,
        error_signature_rows: spans.filter((s) => s.status_message !== "").length,
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
