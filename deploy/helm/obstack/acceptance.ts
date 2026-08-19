/**
 * S2.2 stack-on-kind acceptance harness — the D17 tsx facade path against the
 * cluster's ClickHouse (D35 names it: the `web` image is deliberately not in
 * the chart, so the exit is asserted through the same
 * `apps/web/src/server/data.ts` facade the app renders from).
 *
 * Two commands, both invoked by `acceptance.sh` (CI runs that same script —
 * S2.1 L3):
 *
 *   assert <trace_id>   — the whole-trace checks shared with compose's
 *                         smoke.ts (`deploy/compose/trace-checks.ts`: four
 *                         layers, cost/token, correlated logs, listed), plus
 *                         the D37 evidence bundle on the data the UI renders:
 *                         ≥1 SOLID row with pod metadata, ≥1 NEARBY row from
 *                         the uninstrumented sidecar, zero duplicated bodies.
 *   genai-fixture       — the D38(e) rider: one collector-routed event-form
 *                         GenAI log record lands with prompt/completion
 *                         filled (bring-your-own-OTel end-to-end).
 *
 * Standalone, from the repo root (CLICKHOUSE_URL etc. must point at the
 * cluster — acceptance.sh's port-forwards, by default):
 *   npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
 *     deploy/helm/obstack/acceptance.ts assert <trace_id>
 */
import { randomBytes } from "node:crypto";
import type { Trace } from "@/lib/types";
import {
  awaitWholeTrace,
  DEMO_WORKSPACE,
  REQUIRED_LAYERS,
  TraceIncompleteError,
} from "../../compose/trace-checks";

/** The demo pod's uninstrumented container (templates/demo/deployment.yaml) —
 *  D37.2's genuine NEARBY source. Its absence is a red check, never a silent
 *  pass on zero. */
const SIDECAR_CONTAINER = "sidecar";

/** The compose arrival timeout plus headroom for the extra hop this path has:
 *  app → collector (1s batch) → ingest (1s batch) → ClickHouse. */
const ARRIVAL_TIMEOUT_MS = 60_000;

/** The fixture rides the same two batch hops; polling stops at first sight. */
const FIXTURE_TIMEOUT_MS = 30_000;

function fail(message: string): never {
  console.error(`acceptance: ${message}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The D37 evidence bundle, asserted on exactly the rows the facade rendered —
 * real rows or red, never inferred (D13/D21).
 */
function d37Problems(traceId: string, trace: Trace): string[] {
  const out: string[] = [];

  // D37 part 1 (as restated by D43): ≥1 SOLID row — a log carrying this
  // trace's trace_id AND populated pod identity, whose load-bearing source
  // is the app's own resource self-identification (the recommended customer
  // pattern); k8sattributes associates on those stamped attributes and
  // enriches node identity on top.
  const solid = trace.logs.filter((l) => l.traceId === traceId);
  const solidWithPod = solid.filter((l) => l.namespace !== "" && l.pod !== "");
  if (solidWithPod.length === 0) {
    out.push(
      `no SOLID row carries pod metadata — ${solid.length} solid log(s), none with populated k8s_namespace/k8s_pod`,
    );
  }

  // D43 standing guard: span k8s_node is the ONLY observable evidence the
  // k8sattributes association is alive — SOLID ns/pod comes from the app's
  // stamping and NEARBY ns/pod from the filelog path parsing, so without
  // this line a collector version bump that broke the association (or a
  // revert to connection-first ordering, which the same-node hairpin SNAT
  // leaves fully inert) would regress silently while everything else
  // stayed green.
  const nodeless = trace.spans.filter((s) => !s.node);
  if (nodeless.length > 0) {
    out.push(
      `${nodeless.length} of ${trace.spans.length} span(s) carry no k8s_node — k8sattributes is not enriching the app-OTLP path (D43)`,
    );
  }

  // D37 part 2: ≥1 NEARBY row from the uninstrumented container (D37.2) —
  // trace-less, joined on (workspace, namespace, pod) + window, rendered
  // distinct (traceId undefined is what LogsRail renders as NEARBY).
  const nearby = trace.logs.filter((l) => l.traceId === undefined);
  const sidecar = nearby.filter((l) => l.container === SIDECAR_CONTAINER);
  if (sidecar.length === 0) {
    out.push(
      `no NEARBY row from the uninstrumented "${SIDECAR_CONTAINER}" container — ${nearby.length} nearby row(s) total; zero is a red check, not a pass`,
    );
  }

  // D37 part 3: zero duplicated bodies across the OTLP and filelog paths, in
  // two shapes measured while building this (deploy/collector/README.md's
  // probes show both):
  //  (a) the same line landing twice outright — two rendered rows with
  //      identical (atMs, body). This is what a filelog re-ship after a
  //      collector restart produces: the container operator re-parses the
  //      original timestamps, so the copies collide exactly.
  //      The key joins the two fields on U+0000, which no log body contains;
  //      written as an escape, never as a literal NUL byte, so git and grep
  //      keep treating this file as text rather than as a binary blob.
  const seen = new Map<string, number>();
  for (const l of trace.logs) {
    seen.set(`${l.atMs}\u0000${l.body}`, (seen.get(`${l.atMs}\u0000${l.body}`) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      const body = key.slice(key.indexOf("\u0000") + 1);
      out.push(`the same line renders ${count} times: ${JSON.stringify(body)}`);
    }
  }
  //  (b) a filelog copy of an OTLP-shipped line — the exclusion-removed shape:
  //      the stdout copy is the OTLP body wrapped in the app's stdout log
  //      format ("<asctime> <level> <message>"), so it arrives as a trace-less
  //      row whose body CONTAINS the solid row's body rather than equalling it.
  for (const s of solid) {
    if (s.body === "") continue;
    for (const n of nearby) {
      if (n.body.includes(s.body)) {
        out.push(
          `an OTLP-shipped line also arrived via filelog: solid ${JSON.stringify(s.body)} is contained in trace-less ${JSON.stringify(n.body)} (container ${JSON.stringify(n.container)})`,
        );
      }
    }
  }
  return out;
}

async function assertTrace(traceId: string): Promise<void> {
  let whole: Trace;
  try {
    whole = await awaitWholeTrace(DEMO_WORKSPACE, traceId, ARRIVAL_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof TraceIncompleteError) {
      for (const p of err.problems) console.error(`acceptance:   - ${p}`);
    }
    throw err;
  }

  const problems = d37Problems(traceId, whole);
  if (problems.length > 0) {
    for (const p of problems) console.error(`acceptance:   - ${p}`);
    fail(`trace ${traceId} landed whole but the D37 evidence bundle failed`);
  }

  const byLayer = REQUIRED_LAYERS.map(
    (l) => `${l}=${whole.spans.filter((s) => s.layer === l).length}`,
  ).join(" ");
  const llm = whole.spans.find((s) => s.layer === "llm")?.llm;
  const solidWithPod = whole.logs.filter(
    (l) => l.traceId === traceId && l.namespace !== "" && l.pod !== "",
  );
  const nearby = whole.logs.filter((l) => l.traceId === undefined);
  const sidecar = nearby.filter((l) => l.container === SIDECAR_CONTAINER);
  const { namespace, pod } = solidWithPod[0];
  console.log(`acceptance: trace ${traceId} lists and resolves through the facade`);
  console.log(
    `acceptance:   ${whole.service} · ${whole.rootName} · ${whole.durationMs}ms · ${whole.spans.length} spans (${byLayer})`,
  );
  console.log(
    `acceptance:   llm ${llm?.model} · ${llm?.inputTokens}+${llm?.outputTokens} tokens · $${whole.costUsd.toFixed(6)}`,
  );
  console.log(
    `acceptance:   D37.1 SOLID: ${solidWithPod.length} row(s) carrying trace_id + pod metadata (${namespace}/${pod})`,
  );
  console.log(
    `acceptance:   D43 k8sattributes alive: ${whole.spans.length} span(s) carry k8s_node (${whole.spans[0].node})`,
  );
  console.log(
    `acceptance:   D37.2 NEARBY: ${sidecar.length} row(s) from the uninstrumented "${SIDECAR_CONTAINER}" container (${nearby.length} nearby total)`,
  );
  console.log(
    `acceptance:   D37.3 zero duplicated bodies across ${whole.logs.length} rendered log row(s)`,
  );
  console.log("acceptance: PASS");
}

/**
 * D38(e): one collector-routed event-form GenAI fixture — a log record
 * carrying `gen_ai.input.messages`/`gen_ai.output.messages` sent to the
 * collector's own OTLP endpoint lands in ClickHouse with prompt/completion
 * filled. The message-array shape is what upstream's Events API emits
 * (semconv gen-ai-events rev v1.37.0), in the pre-serialised-string form the
 * ingest fixtures pin (`services/ingest/internal/mapping/mapping_test.go`);
 * the fill rule stores the attribute's string form verbatim (D38(a)), so the
 * assertion is byte equality.
 */
async function genaiFixture(): Promise<void> {
  const otlpUrl = process.env.OBSTACK_COLLECTOR_OTLP_URL ?? "http://127.0.0.1:14318";
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const inputMessages = `[{"role":"user","parts":[{"type":"text","content":"stack acceptance fixture ${traceId}"}]}]`;
  const outputMessages = `[{"role":"assistant","parts":[{"type":"text","content":"stack acceptance completion"}]}]`;

  // OTLP/HTTP JSON encoding: trace/span ids are hex strings, uint64s are
  // decimal strings. No `body` — a content carrier lands with an honest
  // empty body (T2's contract), which is also asserted below.
  const nowNs = (BigInt(Date.now()) * BigInt(1_000_000)).toString();
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "stack-acceptance-fixture" } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: nowNs,
                observedTimeUnixNano: nowNs,
                severityNumber: 9,
                severityText: "INFO",
                traceId,
                spanId,
                attributes: [
                  { key: "gen_ai.input.messages", value: { stringValue: inputMessages } },
                  { key: "gen_ai.output.messages", value: { stringValue: outputMessages } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const res = await fetch(`${otlpUrl}/v1/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    fail(`collector OTLP endpoint ${otlpUrl}/v1/logs answered ${res.status} ${res.statusText}`);
  }

  // Read back with the same parameterized readonly client the app uses (D11 —
  // values bound through query_params, never interpolated), scoped to the one
  // workspace the collector's `ok_dev_local` key resolves to — the `api_keys`
  // row the pg-migrate Job seeds (D96/D113). The scope binds `workspace_id`
  // itself, so the SQL below names the placeholder and the params below never
  // carry it.
  const { forWorkspace } = await import("@/server/clickhouse");
  const ch = forWorkspace(DEMO_WORKSPACE);
  const FIXTURE_ROW_SQL = `
SELECT span_id, body, prompt, completion, mapKeys(attributes) AS attribute_keys
FROM obstack.logs
WHERE workspace_id = {workspace_id:String} AND trace_id = {trace_id:String}`;
  interface FixtureRow {
    span_id: string;
    body: string;
    prompt: string;
    completion: string;
    attribute_keys: string[];
  }

  const deadline = Date.now() + FIXTURE_TIMEOUT_MS;
  let rows: FixtureRow[] = [];
  for (;;) {
    rows = await ch.queryRows<FixtureRow>(FIXTURE_ROW_SQL, { trace_id: traceId });
    if (rows.length > 0) break;
    if (Date.now() > deadline) {
      fail(
        `GenAI event-form fixture did not land within ${FIXTURE_TIMEOUT_MS / 1000}s (trace_id ${traceId})`,
      );
    }
    await sleep(1_000);
  }

  const problems: string[] = [];
  if (rows.length !== 1) problems.push(`expected 1 row for trace_id ${traceId}, got ${rows.length}`);
  const row = rows[0];
  if (row.span_id !== spanId) problems.push(`span_id = ${JSON.stringify(row.span_id)}, want ${spanId}`);
  if (row.prompt !== inputMessages) problems.push(`prompt did not round-trip verbatim: ${JSON.stringify(row.prompt)}`);
  if (row.completion !== outputMessages) problems.push(`completion did not round-trip verbatim: ${JSON.stringify(row.completion)}`);
  if (row.body !== "") problems.push(`body = ${JSON.stringify(row.body)}, want empty (content carrier)`);
  for (const key of row.attribute_keys) {
    if (key === "gen_ai.input.messages" || key === "gen_ai.output.messages") {
      problems.push(`${key} is duplicated into the attributes map (D8-AMENDMENT)`);
    }
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`acceptance:   - ${p}`);
    fail("GenAI event-form fixture landed wrong");
  }

  console.log(
    `acceptance:   D38(e) collector-routed event-form fixture landed with prompt/completion filled verbatim (trace_id ${traceId})`,
  );
  console.log("acceptance: PASS");
}

async function main(): Promise<void> {
  // The facade resolves its mode at import time (D13) and the clickhouse
  // module reads its env on first query — set everything before either import
  // happens (both are dynamic, inside the calls below). Defaults match
  // acceptance.sh's port-forwards and values.yaml's dev credentials.
  process.env.OBSTACK_DATA_MODE = "live";
  process.env.CLICKHOUSE_URL ??= "http://127.0.0.1:18123";
  process.env.CLICKHOUSE_USER ??= "obstack_web";
  process.env.CLICKHOUSE_PASSWORD ??= "obstack_web_dev";

  const [command, arg] = process.argv.slice(2);
  if (command === "assert" && arg) return assertTrace(arg);
  if (command === "genai-fixture" && !arg) return genaiFixture();
  fail("usage: acceptance.ts assert <trace_id> | acceptance.ts genai-fixture");
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
