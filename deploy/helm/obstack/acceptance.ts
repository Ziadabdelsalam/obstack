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
 *   events <trace_id> <pod>
 *                       — the S4.4 rider: a LIVE Kubernetes event on the pod
 *                         that served the trace reaches `Trace.k8sEvents`
 *                         through the same facade, so the product's "k8s
 *                         events on the timeline" claim is asserted rather
 *                         than asserted-about.
 *
 * Standalone, from the repo root (CLICKHOUSE_URL etc. must point at the
 * cluster — acceptance.sh's port-forwards, by default):
 *   npx tsx --tsconfig apps/web/tsconfig.json --conditions react-server \
 *     deploy/helm/obstack/acceptance.ts assert <trace_id>
 */
import { randomBytes } from "node:crypto";
import type { K8sEvent, Trace } from "@/lib/types";
import { NEARBY_LOG_WINDOW_S } from "@/lib/nearby-logs";
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

/** The `Killing` event is emitted by the kubelet a second or two after the
 *  delete, then rides the events collector's batch and ingest's 1s batch. The
 *  generous ceiling is deliberate: this poll is the only place a genuinely
 *  broken cluster-events path can be told apart from a slow one, and it stops
 *  at first sight, so the cost of the headroom is zero on a healthy run. */
const EVENTS_TIMEOUT_MS = 90_000;

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

/**
 * S4.4: live Kubernetes events reach the trace's timeline.
 *
 * The caller (`acceptance.sh`) has just deleted the pod that served
 * `traceId`, so the kubelet emits a `Killing` event against exactly that Pod.
 * Everything between there and here is the product under test: the chart's
 * events collector watches the API server, ships the event as an OTLP log
 * record, ingest stores it trace-less with `k8s.event.uid` set, and
 * `queryTrace`'s K8S_EVENTS_SQL pair-matches
 * `(k8s.namespace.name, k8s.object.name)` against this trace's spans inside
 * the nearby window. Read back through the SAME facade `assertTrace` uses
 * (`dataForWorkspace(...).getTrace`) — the claim is about what the trace
 * detail page renders, so it is asserted on the rendered shape and nowhere
 * else (D13/D17).
 *
 * Not `awaitWholeTrace`: that helper's contract is "the trace landed whole",
 * which this trace satisfies within seconds and which says nothing about
 * events. Polling `getTrace` directly keeps the deadline attached to the one
 * fact this rider is about.
 */
async function clusterEvents(traceId: string, pod: string): Promise<void> {
  const { dataForWorkspace } = await import("@/server/data");
  const data = dataForWorkspace(DEMO_WORKSPACE);
  const windowMs = NEARBY_LOG_WINDOW_S * 1_000;

  const deadline = Date.now() + EVENTS_TIMEOUT_MS;
  let trace: Trace | undefined;
  let event: K8sEvent | undefined;
  for (;;) {
    trace = await data.getTrace(traceId);
    // First event ON THIS POD, in the query's timestamp order. Deliberately
    // not "first event whose kind is restart": narrowing the poll to the
    // answer we want would turn a mis-mapped reason into a timeout instead of
    // the specific red check below.
    event = trace?.k8sEvents?.find((e) => e.pod === pod);
    if (event) break;
    if (Date.now() > deadline) break;
    await sleep(1_000);
  }

  if (!event) {
    // A timeout here has three distinguishable causes — no event rows reached
    // ClickHouse at all (collector/RBAC), rows landed but not for this pod
    // (the wrong pod was deleted), or rows landed for this pod but outside
    // the window (the join or the timestamps). Print the evidence that
    // separates them rather than a bare "not found".
    const { forWorkspace } = await import("@/server/clickhouse");
    const ch = forWorkspace(DEMO_WORKSPACE);
    const EVENT_ROW_COUNT_SQL = `
SELECT count() AS total
FROM obstack.logs
WHERE workspace_id = {workspace_id:String} AND attributes['k8s.event.uid'] != ''`;
    const EVENT_ROW_BREAKDOWN_SQL = `
SELECT
    attributes['k8s.event.reason']         AS reason,
    resource_attributes['k8s.object.kind'] AS object_kind,
    resource_attributes['k8s.object.name'] AS object_name,
    count()                                AS n
FROM obstack.logs
WHERE workspace_id = {workspace_id:String} AND attributes['k8s.event.uid'] != ''
GROUP BY reason, object_kind, object_name
ORDER BY n DESC
LIMIT 10`;
    const [{ total } = { total: "0" }] =
      await ch.queryRows<{ total: string }>(EVENT_ROW_COUNT_SQL);
    const breakdown = await ch.queryRows<{
      reason: string;
      object_kind: string;
      object_name: string;
      n: string;
    }>(EVENT_ROW_BREAKDOWN_SQL);

    console.error(
      `acceptance:   - trace.k8sEvents: ${
        trace === undefined
          ? "the trace itself did not resolve through the facade"
          : trace.k8sEvents === undefined
            ? "absent (no event mapped for this trace)"
            : trace.k8sEvents
                .map((e) => `${e.kind}/${e.severity} on ${e.pod} at +${e.atMs}ms`)
                .join("; ")
      }`,
    );
    console.error(
      `acceptance:   - obstack.logs rows carrying k8s.event.uid in ${DEMO_WORKSPACE}: ${total}`,
    );
    for (const row of breakdown) {
      console.error(
        `acceptance:     ${row.n}× ${row.reason} on ${row.object_kind}/${row.object_name}`,
      );
    }
    fail(
      `no k8s event for pod ${pod} reached trace ${traceId} within ${EVENTS_TIMEOUT_MS / 1000}s`,
    );
  }

  const whole = trace as Trace;
  const problems: string[] = [];
  // `Killing` is a Normal-Type event, so the receiver stamps it INFO and
  // EVENT_KINDS (adapters.ts) folds the reason to "restart". Both halves of
  // that mapping are asserted, because either one silently changing is
  // exactly the regression this rider exists to catch.
  if (event.kind !== "restart") {
    problems.push(`kind = ${JSON.stringify(event.kind)}, want "restart" (reason Killing)`);
  }
  if (event.severity !== "info") {
    problems.push(`severity = ${JSON.stringify(event.severity)}, want "info" (a Normal-Type event)`);
  }
  if (event.id === "") problems.push("id is empty — k8s.event.uid did not survive the pipeline");
  if (event.label === "") problems.push("label is empty — neither the event message nor its reason arrived");
  // The window the query itself binds (NEARBY_LOG_WINDOW_NS), restated on the
  // rendered offsets: an event outside it is one K8S_EVENTS_SQL should never
  // have returned.
  if (event.atMs < -windowMs || event.atMs > whole.durationMs + windowMs) {
    problems.push(
      `atMs ${event.atMs} is outside [${-windowMs}, ${whole.durationMs + windowMs}] — the ±${NEARBY_LOG_WINDOW_S}s window around a ${whole.durationMs}ms trace`,
    );
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`acceptance:   - ${p}`);
    fail(`the k8s event on ${pod} landed wrong`);
  }

  const onPod = whole.k8sEvents?.filter((e) => e.pod === pod) ?? [];
  console.log(
    `acceptance:   S4.4 cluster events alive: ${JSON.stringify(event.label)} on ${pod} at +${event.atMs}ms → kind=${event.kind} severity=${event.severity} (${onPod.length} event(s) on this pod, ±${NEARBY_LOG_WINDOW_S}s of a ${whole.durationMs}ms trace)`,
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

  const [command, arg, arg2] = process.argv.slice(2);
  if (command === "assert" && arg) return assertTrace(arg);
  if (command === "genai-fixture" && !arg) return genaiFixture();
  if (command === "events" && arg && arg2) return clusterEvents(arg, arg2);
  fail(
    "usage: acceptance.ts assert <trace_id> | acceptance.ts genai-fixture | acceptance.ts events <trace_id> <pod>",
  );
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
