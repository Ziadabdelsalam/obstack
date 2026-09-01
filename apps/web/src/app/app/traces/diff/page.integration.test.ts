import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createClient } from "@clickhouse/client";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait clickhouse ingest
// then:     npm test --workspace apps/web
//
// The seeded half of T5's done-check (D400): two REAL traces, read the way the
// page reads them — `dataForWorkspace(...).getTrace()` twice plus
// `searchTraces({})` for the picker — folded by the component the page renders.
// The hermetic half (the D367 shape, the verbatim move, the compare href) is
// `page.test.ts` next door. This file exists because the fold rule and the
// foreign-id answer are properties of the DATA, and no source-text test can
// reach them: `rowsFor` runs over `Trace.spans` that only a real query builds.
//
// It skips when no ClickHouse answers, like every other *.integration.test.ts
// here; CI brings the compose stack up and fails the job on an unexpected skip
// (.github/workflows/web.yml, "D36 skip trap"), so it cannot go quietly green.

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL ?? "http://127.0.0.1:8123";
const WEB_USER = process.env.CLICKHOUSE_USER ?? "obstack_web";
const WEB_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "obstack_web_dev";
const INGEST_PASSWORD =
  process.env.OBSTACK_TEST_CLICKHOUSE_INGEST_PASSWORD ?? "obstack_ingest_dev";

// Read lazily by `@/server/clickhouse`'s `getClient()` on the first query, and
// by `@/server/data` at module load — both below, both after this.
process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
process.env.CLICKHOUSE_USER = WEB_USER;
process.env.CLICKHOUSE_PASSWORD = WEB_PASSWORD;
process.env.OBSTACK_DATA_MODE = "live";

// D156: `TraceDiffLive` is a server component, but it names `next/link` and
// `lucide-react` as element types, and both call `createContext` at module
// scope — which this runner's react-server React does not have. One missing
// function is the whole obstacle, so this file supplies it and then imports the
// real component. Safe because `node --test` isolates per file; nothing below
// RENDERS anything (a React element is a plain object, and `<Link>` inside one
// is never called).
const react = createRequire(import.meta.url)("react");
react.createContext ??= () => ({});

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
 * Two workspaces of this run's own, never the compose dev default `ws_demo`
 * (the `traces.integration.test.ts` rule): these rows cannot be deleted, and a
 * synthetic trace in the demo workspace would show up in the demo UI. B exists
 * for the foreign-id probe — an id that is a real trace SOMEWHERE is the only
 * fixture that can tell a scoped read from an unscoped one.
 */
const WORKSPACE_A = `ws_diff_${randomBytes(4).toString("hex")}`;
const WORKSPACE_B = `ws_diffb_${randomBytes(4).toString("hex")}`;

const NS_PER_MS = BigInt(1_000_000);

/** DateTime64(9,'UTC') wants `'YYYY-MM-DD HH:MM:SS.nnnnnnnnn'`. */
function chTimestamp(epochNs: bigint): string {
  const seconds = epochNs / BigInt(1_000_000_000);
  const nanos = epochNs % BigInt(1_000_000_000);
  const isoSeconds = new Date(Number(seconds) * 1000).toISOString().slice(0, 19).replace("T", " ");
  return `${isoSeconds}.${nanos.toString().padStart(9, "0")}`;
}

function spanRow(row: {
  workspace_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  name: string;
  layer: string;
  start_ms: number;
  duration_ms: number;
}) {
  return {
    workspace_id: row.workspace_id,
    trace_id: row.trace_id,
    span_id: row.span_id,
    parent_span_id: row.parent_span_id,
    name: row.name,
    kind: "server",
    service: "diff-svc",
    status_code: "ok",
    status_message: "",
    layer: row.layer,
    start_time: chTimestamp(BigInt(row.start_ms) * NS_PER_MS),
    duration_ns: (BigInt(row.duration_ms) * NS_PER_MS).toString(),
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
    k8s_container: "app",
    k8s_node: "",
    attributes: {},
    resource_attributes: {},
  };
}

type Element = { type?: unknown; props?: Record<string, unknown> };

/**
 * Every string a rendered tree would show: string children AND string props,
 * because this component hands its slot copy to `<EmptySlot note=…>` rather
 * than inlining it, and that element is never invoked here.
 */
function strings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (Array.isArray(node)) for (const child of node) strings(child, out);
  else if (node && typeof node === "object") {
    const props = (node as Element).props;
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (key === "children" || (value && typeof value === "object")) strings(value, out);
        else if (typeof value === "string") out.push(value);
      }
    }
  }
  return out;
}

test("the live diff over two seeded traces (D400)", async (t) => {
  if (!(await clickhouseReachable())) {
    t.skip(
      `no ClickHouse at ${CLICKHOUSE_URL}; start deploy/compose (down -v first) to run this test`,
    );
    return;
  }

  const { dataForWorkspace } = await import("@/server/data");
  const { TraceDiffLive, DIFF_PICKER_SIZE } = await import("@/components/trace/TraceDiffLive");

  const suffix = randomBytes(6).toString("hex");
  const idA = `it_diff_a_${suffix}`;
  const idB = `it_diff_b_${suffix}`;
  const idForeign = `it_diff_foreign_${suffix}`;
  const nowMs = Date.now();

  // A is the newer of the two, so `searchTraces({})`'s start-descending order
  // makes the picker's first row — and therefore the page's default `a` — A.
  const startA = nowMs - 60_000;
  const startB = nowMs - 120_000;

  await seed.insert({
    table: "spans",
    format: "JSONEachRow",
    values: [
      // trace A: 500ms root, a 400ms model call, and a 30ms lookup B never made
      spanRow({ workspace_id: WORKSPACE_A, trace_id: idA, span_id: "s1", parent_span_id: "", name: "POST /chat", layer: "api", start_ms: startA, duration_ms: 500 }),
      spanRow({ workspace_id: WORKSPACE_A, trace_id: idA, span_id: "s2", parent_span_id: "s1", name: "llm.call", layer: "llm", start_ms: startA + 50, duration_ms: 400 }),
      spanRow({ workspace_id: WORKSPACE_A, trace_id: idA, span_id: "s3", parent_span_id: "s1", name: "cache.lookup", layer: "infra", start_ms: startA + 10, duration_ms: 30 }),
      // trace B: the same shape, faster, without the lookup
      spanRow({ workspace_id: WORKSPACE_A, trace_id: idB, span_id: "s1", parent_span_id: "", name: "POST /chat", layer: "api", start_ms: startB, duration_ms: 250 }),
      spanRow({ workspace_id: WORKSPACE_A, trace_id: idB, span_id: "s2", parent_span_id: "s1", name: "llm.call", layer: "llm", start_ms: startB + 50, duration_ms: 150 }),
      // a REAL trace, in the other workspace
      spanRow({ workspace_id: WORKSPACE_B, trace_id: idForeign, span_id: "s1", parent_span_id: "", name: "POST /chat", layer: "api", start_ms: startA, duration_ms: 999 }),
    ],
  });

  const data = dataForWorkspace(WORKSPACE_A);
  const [a, b, search] = await Promise.all([
    data.getTrace(idA),
    data.getTrace(idB),
    data.searchTraces({}),
  ]);
  assert.ok(a, "the facade found no trace A");
  assert.ok(b, "the facade found no trace B");
  const recent = search.traces.slice(0, DIFF_PICKER_SIZE);

  await t.test("the picker is this workspace's own recent traces, newest first", () => {
    assert.deepEqual(recent.map((tr) => tr.id), [idA, idB]);
  });

  await t.test("the rows fold both traces by span name, with the deltas and the only-in-A row", () => {
    const text = strings(TraceDiffLive({ a, b, recent, aAutoPicked: false })).join(" ");
    for (const name of ["POST /chat", "llm.call", "cache.lookup"]) {
      assert.ok(text.includes(name), `the diff never rendered the "${name}" row`);
    }
    // 500 vs 250 and 400 vs 150 — both +250ms, both slower.
    assert.equal(
      text.split("+250ms").length - 1,
      2,
      "expected the root and the model call to each read +250ms slower",
    );
    // The 30ms lookup exists in A only: a delta would be a fabricated number.
    assert.ok(text.includes("only in A"), "a span present in one trace only must say so, not show a delta");
    assert.ok(!text.includes("only in B"), "nothing is unique to B in this fixture");
    // The header's total: A's 500ms wall time against B's 250ms.
    assert.equal(a.durationMs - b.durationMs, 250);
    assert.ok(text.includes("slower"));
  });

  await t.test("a real trace in another workspace is 'trace not found in this workspace' (D113)", async () => {
    const foreign = await data.getTrace(idForeign);
    assert.equal(foreign, undefined, "a scoped read returned another workspace's trace");
    // What the page does with that: pass null, and the surface says so rather
    // than silently comparing something else.
    const text = strings(TraceDiffLive({ a: null, b, recent, aAutoPicked: false })).join(" ");
    assert.ok(
      text.includes("trace not found in this workspace"),
      "an unresolved side must be named, not blank",
    );
    assert.ok(!text.includes("only in"), "no diff table is rendered with a side missing");
    // …and the other workspace really does have it, so the null above is the
    // scope talking and not an empty table.
    const owner = await dataForWorkspace(WORKSPACE_B).getTrace(idForeign);
    assert.equal(owner?.id, idForeign);
  });

  await t.test("no second trace picked yet: the picker and 'pick a second trace', no table", () => {
    const text = strings(TraceDiffLive({ a, b: null, recent, aAutoPicked: false })).join(" ");
    assert.ok(text.includes("pick a second trace"));
    assert.ok(!text.includes("only in A"), "no comparison is rendered against a trace nobody picked");
    assert.ok(text.includes(idB), "the picker must still offer this workspace's other trace");
  });

  // D416: `page.tsx` is a source-text test's job (page.test.ts) — this is the
  // seeded half, over the SAME resolved trace A, toggling only `aAutoPicked`.
  await t.test("D416: an auto-picked A is captioned; a named ?a= carries no caption", () => {
    const autoPicked = strings(TraceDiffLive({ a, b, recent, aAutoPicked: true })).join(" ");
    assert.ok(
      autoPicked.includes("most recent trace — pick another to compare"),
      "an auto-picked A (?a= absent) must caption itself",
    );
    const named = strings(TraceDiffLive({ a, b, recent, aAutoPicked: false })).join(" ");
    assert.ok(
      !named.includes("most recent trace — pick another to compare"),
      "a named ?a= must never carry the auto-pick caption",
    );
  });
});
