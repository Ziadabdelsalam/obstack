import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResultRow } from "pg";
import {
  MAX_DASHBOARDS,
  MAX_PINNED_WIDGETS,
  MAX_WIDGETS_PER_DASHBOARD,
  type DashboardWidget,
  type NewDashboardWidget,
} from "@/lib/dashboard-types";
import {
  DashboardRefusal,
  addWidget,
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  moveWidget,
  removeWidget,
  renameDashboard,
  setWidgetPinned,
} from "./dashboards";
import type { QueryRows } from "./postgres";

// run with: npm test --workspace apps/web
//
// The dashboards store's contract with no Postgres at all (D432's hermetic
// half): every statement is bound to the workspace it was handed, every mutation
// takes the D197 advisory lock FIRST, a payload D430 refuses costs ZERO
// statements, and the widget that reaches JSONB is built key by key so a
// client's own `id` or `workspace_id` can never ride in. Whether the rows are
// actually disjoint — and whether the UNIQUE key and the caps hold against a
// real engine — is `dashboards.integration.test.ts`; this file proves what the
// statements SAY and in what ORDER.
//
// The read path is a parameter (D113), so this file needs neither a request nor
// a server: it must pass on a machine with no Postgres at all, and `web`'s skip
// trap allows no skips.

type Statement = { sql: string; params?: unknown[] };

/**
 * A recorder that answers by statement SHAPE, because a widget mutation is a
 * read-modify-write: it locks, reads the row, may count, writes, and reads back,
 * and handing all five the same rows would prove nothing about any of them.
 *
 * The store's mutations take a `TxQuery` and its reads a `QueryRows` (D199).
 * There is no transaction here to mint the brand from, so `as never` hands the
 * same recorder to both seams (the `ingest-health.test.ts` idiom); that the
 * write really does run inside a locked transaction is proven against real
 * Postgres by `dashboards.integration.test.ts`.
 */
function recordingQuery(reply: (sql: string) => unknown[] = () => []) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    seen.push({ sql, params });
    return reply(sql) as Row[];
  };
  return { query: query as never, seen };
}

/** What the add-widget form and Explore's save both hand the store: no id. */
const newWidget = (over: Partial<NewDashboardWidget> = {}): NewDashboardWidget => ({
  title: "p90 latency",
  kind: "timeseries",
  metric: "http.server.duration",
  type: "histogram",
  agg: "p90",
  range: "6h",
  groupBy: null,
  pinned: false,
  ...over,
});

/** The same widget as the store holds it, id and all. */
const widget = (over: Partial<DashboardWidget> = {}): DashboardWidget => ({
  id: "wdg_00112233445566aa",
  ...newWidget(over),
  ...over,
});

const TWO = [widget({ id: "wdg_aaaaaaaaaaaaaaaa" }), widget({ id: "wdg_bbbbbbbbbbbbbbbb" })];

/** A row as Postgres RETURNs it: JSONB already parsed, TIMESTAMPTZ a Date. */
const dashRow = (widgets: DashboardWidget[] = TWO) => ({
  id: "dash_00112233445566aa",
  name: "Latency",
  widgets,
  updated_at: new Date("2026-09-01T10:00:00Z"),
});

type StoreState = {
  row?: ReturnType<typeof dashRow> | null;
  dashboards?: number;
  pinsElsewhere?: number;
  onWrite?: () => never;
};

/** The engine, as far as this file is concerned: which statement gets which rows. */
function engine({ row = dashRow(), dashboards = 0, pinsElsewhere = 0, onWrite }: StoreState = {}) {
  return (sql: string): unknown[] => {
    if (sql.includes("pg_advisory_xact_lock")) return [];
    // Before the plain count: the pin count is also a `count(*)`.
    if (sql.includes("jsonb_array_elements")) return [{ n: pinsElsewhere }];
    if (sql.includes("count(*)")) return [{ n: dashboards }];
    if (sql.includes("SELECT id, name, widgets")) return row ? [row] : [];
    if (onWrite && /INSERT|UPDATE/.test(sql)) onWrite();
    return [];
  };
}

/** A refusal is judged by its class AND its exact sentence: the surface prints it verbatim (D430/D436). */
async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof DashboardRefusal, `not a DashboardRefusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

const writes = (seen: Statement[]) => seen.filter((s) => /INSERT|UPDATE|DELETE/.test(s.sql));

// ---- the store: one workspace, bound, on every statement (D7/D11/D113/D130) ----

test("every statement is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery(engine());

  await listDashboards("ws_a", query);
  await getDashboard("ws_a", "dash_00112233445566aa", query);
  await createDashboard("ws_a", "Latency", query);
  await renameDashboard("ws_a", "dash_00112233445566aa", "Latency v2", query);
  await addWidget("ws_a", "dash_00112233445566aa", newWidget(), query);
  await removeWidget("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", query);
  await moveWidget("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", "down", query);
  await setWidgetPinned("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", true, query);
  await deleteDashboard("ws_a", "dash_00112233445566aa", query);

  // Thirty, not nine: every mutation is lock → read → (count) → write → read
  // back. A statement added or dropped without joining this loop goes red here.
  assert.equal(seen.length, 30, "a statement was added or dropped without joining this loop");
  for (const { sql, params } of seen) {
    // Both halves, because either alone is passable: SQL that names the column
    // but binds someone else's id, or a first binding no predicate reads. The
    // advisory lock keys on the workspace through `hashtext($1)` rather than a
    // `workspace_id` column, so it satisfies the naming half the same way.
    assert.match(
      sql,
      /workspace_id|pg_advisory_xact_lock\(hashtext\(\$1\)\)/,
      `a statement does not scope by workspace: ${sql}`,
    );
    assert.equal(params?.[0], "ws_a", `a statement bound ${String(params?.[0])} as its workspace`);
  }
});

test("the workspace is a binding, never something the caller filters afterwards", async () => {
  const { query, seen } = recordingQuery(engine());
  await listDashboards("ws_b", query);

  assert.match(seen[0].sql, /WHERE workspace_id = \$1/);
  assert.deepEqual(seen[0].params, ["ws_b"]);
  // Oldest first (D424); the name breaks the tie so two dashboards created in
  // one transaction cannot swap places between reads.
  assert.match(seen[0].sql, /ORDER BY created_at, name/);
});

test("a read for one dashboard is judged by the workspace in the WHERE clause", async () => {
  const { query, seen } = recordingQuery(engine());
  await getDashboard("ws_b", "dash_00112233445566aa", query);
  assert.match(seen[0].sql, /WHERE workspace_id = \$1 AND id = \$2/);
  assert.deepEqual(seen[0].params, ["ws_b", "dash_00112233445566aa"]);

  // Another workspace's id answers exactly as an invented one does — `null`,
  // which the page renders as the D436 sentence. It never 500s, and it never
  // distinguishes "not yours" from "not there".
  const { query: empty } = recordingQuery(engine({ row: null }));
  assert.equal(await getDashboard("ws_b", "dash_00112233445566aa", empty), null);
});

// ---- D429: the lock is the first statement of every mutation ----

test("every mutation takes the workspace advisory lock before it does anything else", async () => {
  const mutations: [string, (query: never) => Promise<unknown>][] = [
    ["createDashboard", (q) => createDashboard("ws_a", "Latency", q)],
    ["renameDashboard", (q) => renameDashboard("ws_a", "dash_00112233445566aa", "New", q)],
    ["deleteDashboard", (q) => deleteDashboard("ws_a", "dash_00112233445566aa", q)],
    ["addWidget", (q) => addWidget("ws_a", "dash_00112233445566aa", newWidget(), q)],
    ["removeWidget", (q) => removeWidget("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", q)],
    ["moveWidget", (q) => moveWidget("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", "down", q)],
    ["setWidgetPinned", (q) => setWidgetPinned("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", true, q)],
  ];

  for (const [name, run] of mutations) {
    const { query, seen } = recordingQuery(engine());
    await run(query);
    // The lock is transaction-scoped and serializes a read-modify-write only if
    // it is taken before the read (D197): a lock issued after the array was read
    // would let two tabs both see eleven widgets and both write a twelfth.
    assert.match(seen[0].sql, /pg_advisory_xact_lock\(hashtext\(\$1\)\)/, `${name} did not lock first`);
    assert.deepEqual(seen[0].params, ["ws_a"], `${name} locked the wrong workspace`);
  }
});

test("a mutation answers with what the store holds, not with what the caller asked for", async () => {
  // Every write is followed by a read of the row it wrote (D429), so a surface
  // can never show a widget the database refused.
  const runs: [string, (query: never) => Promise<unknown>][] = [
    ["createDashboard", (q) => createDashboard("ws_a", "Latency", q)],
    ["renameDashboard", (q) => renameDashboard("ws_a", "dash_00112233445566aa", "New", q)],
    ["addWidget", (q) => addWidget("ws_a", "dash_00112233445566aa", newWidget(), q)],
    ["removeWidget", (q) => removeWidget("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", q)],
    ["setWidgetPinned", (q) => setWidgetPinned("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", true, q)],
  ];

  for (const [name, run] of runs) {
    const { query, seen } = recordingQuery(engine());
    const answer = await run(query);
    assert.match(seen[seen.length - 1].sql, /SELECT id, name, widgets/, `${name} answered without reading back`);
    assert.deepEqual(answer, {
      id: "dash_00112233445566aa",
      name: "Latency",
      widgets: TWO,
      updatedAt: "2026-09-01T10:00:00.000Z",
    });
  }

  // The delete is the exception the shape names: its answer is the fresh LIST,
  // because the row the caller named is gone.
  const { query, seen } = recordingQuery(engine());
  const list = await deleteDashboard("ws_a", "dash_00112233445566aa", query);
  assert.match(seen[seen.length - 1].sql, /ORDER BY created_at, name/);
  assert.equal(list.length, 1);
});

// ---- D430: a refused payload runs ZERO statements ----

test("every shape refusal is judged before Postgres and costs no statement", async () => {
  const cases: [string, (query: never) => Promise<unknown>, string][] = [
    ["blank name", (q) => createDashboard("ws_a", "   ", q), "name is required"],
    ["long name", (q) => createDashboard("ws_a", "x".repeat(81), q), "name is longer than 80 characters"],
    ["blank rename", (q) => renameDashboard("ws_a", "d", "", q), "name is required"],
    ["blank title", (q) => addWidget("ws_a", "d", newWidget({ title: " " }), q), "name is required"],
    [
      "long title",
      (q) => addWidget("ws_a", "d", newWidget({ title: "t".repeat(81) }), q),
      "name is longer than 80 characters",
    ],
    [
      "fifth kind",
      (q) => addWidget("ws_a", "d", newWidget({ kind: "heatmap" as never }), q),
      'unknown widget kind "heatmap"',
    ],
    [
      "unknown type",
      (q) => addWidget("ws_a", "d", newWidget({ type: "summary" as never }), q),
      'unknown metric type "summary"',
    ],
    [
      "agg the metric type does not answer",
      (q) => addWidget("ws_a", "d", newWidget({ type: "sum", agg: "p90" }), q),
      '"p90" is not an aggregation a sum answers',
    ],
    [
      "unknown range",
      (q) => addWidget("ws_a", "d", newWidget({ range: "7d" as never }), q),
      'unknown range "7d"',
    ],
    ["blank metric", (q) => addWidget("ws_a", "d", newWidget({ metric: " " }), q), "metric is required"],
    [
      "blank group-by",
      (q) => addWidget("ws_a", "d", newWidget({ groupBy: "  " }), q),
      "group-by is an attribute key or nothing at all",
    ],
    [
      "a grouped stat",
      (q) => addWidget("ws_a", "d", newWidget({ kind: "stat", groupBy: "service.name" }), q),
      "a stat has no group-by",
    ],
    [
      "an ungrouped top-n",
      (q) => addWidget("ws_a", "d", newWidget({ kind: "topn" }), q),
      "top-n and table need a group-by",
    ],
    [
      "an ungrouped table",
      (q) => addWidget("ws_a", "d", newWidget({ kind: "table" }), q),
      "top-n and table need a group-by",
    ],
    [
      "a non-boolean pin",
      (q) => addWidget("ws_a", "d", newWidget({ pinned: "yes" as never }), q),
      "pinned is true or false",
    ],
    [
      "a non-boolean pin on the toggle",
      (q) => setWidgetPinned("ws_a", "d", "w", "yes" as never, q),
      "pinned is true or false",
    ],
    [
      "an invented direction",
      (q) => moveWidget("ws_a", "d", "w", "sideways" as never, q),
      'unknown direction "sideways"',
    ],
    [
      "a payload that is not an object at all",
      (q) => addWidget("ws_a", "d", "widget" as never, q),
      "name is required",
    ],
  ];

  for (const [name, run, sentence] of cases) {
    const { query, seen } = recordingQuery(engine());
    await refusal(run(query), sentence);
    assert.deepEqual(seen, [], `${name} reached the database`);
  }
});

test("a metric type borrowed from the prototype chain is refused, not thrown (D68)", async () => {
  // `VALID_AGGS[type]` on an unchecked payload walks the chain: `constructor`
  // answers a function whose `.includes` is not one, and that TypeError is not a
  // `DashboardRefusal` — the action's catch would let it out as a 500. The
  // measured D68 failure shape, reached here through a server action's payload
  // rather than a URL.
  for (const hostile of ["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"]) {
    const { query, seen } = recordingQuery(engine());
    await refusal(
      addWidget("ws_a", "d", newWidget({ type: hostile as never }), query),
      `unknown metric type ${JSON.stringify(hostile)}`,
    );
    assert.deepEqual(seen, [], `${hostile} reached the database`);
  }
});

test("the stored widget carries exactly the contract's keys — a client's own id and workspace_id are dropped", async () => {
  const { query, seen } = recordingQuery(engine({ row: dashRow([]) }));
  // Neither the form nor Explore can produce this; a direct POST at the server
  // action can, and a row holding it would let a client name its own primary key
  // — or, worse, a workspace.
  const hostile = {
    ...newWidget({ groupBy: "service.name", kind: "topn", pinned: false }),
    id: "wdg_ffffffffffffffff",
    workspace_id: "ws_victim",
    nested: { a: "b" },
  } as unknown as NewDashboardWidget;

  await addWidget("ws_a", "dash_00112233445566aa", hostile, query);

  const [update] = writes(seen);
  assert.match(update.sql, /SET widgets = \$3::jsonb/);
  const [saved] = JSON.parse((update.params as string[])[2]) as DashboardWidget[];
  assert.deepEqual(Object.keys(saved).sort(), [
    "agg",
    "groupBy",
    "id",
    "kind",
    "metric",
    "pinned",
    "range",
    "title",
    "type",
  ]);
  // App-generated (D437/D116), and never the one the caller sent.
  assert.match(saved.id, /^wdg_[0-9a-f]{16}$/);
  assert.notEqual(saved.id, "wdg_ffffffffffffffff");
  for (const { params } of seen) {
    assert.equal(params?.includes("ws_victim"), false, "a payload's workspace reached a binding");
    assert.equal(params?.includes("wdg_ffffffffffffffff"), false, "a payload's id reached a binding");
  }
});

// ---- D424: the name is the identity, and a taken one is refused ----

test("creating under a taken name is refused with the sentence, never upserted", async () => {
  const duplicate = (): never => {
    throw Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  };
  const { query, seen } = recordingQuery(engine({ onWrite: duplicate }));

  await refusal(createDashboard("ws_a", "Latency", query), "a dashboard named “Latency” already exists");
  // The refusal is the UNIQUE key's, not a SELECT this module could run first:
  // two tabs creating the same name both pass such a SELECT. And there is no
  // ON CONFLICT — an upsert here would silently replace someone's widgets.
  const [insert] = writes(seen);
  assert.match(insert.sql, /INSERT INTO dashboards \(workspace_id, id, name\)/);
  assert.equal(/ON CONFLICT/.test(insert.sql), false, insert.sql);

  const { query: renaming } = recordingQuery(engine({ onWrite: duplicate }));
  await refusal(
    renameDashboard("ws_a", "dash_00112233445566aa", "Latency", renaming),
    "a dashboard named “Latency” already exists",
  );
});

test("each dashboard gets its own app-generated id (D437/D116)", async () => {
  const { query, seen } = recordingQuery(engine());
  await createDashboard("ws_a", "one", query);
  await createDashboard("ws_a", "two", query);

  const ids = writes(seen).map((s) => (s.params as string[])[1]);
  assert.match(ids[0], /^dash_[0-9a-f]{16}$/);
  assert.notEqual(ids[0], ids[1]);
});

// ---- D402/D430: the caps are read under the lock, and refuse before any write ----

test("the caps are counted after the lock and refuse before anything is written", async () => {
  const full = recordingQuery(engine({ dashboards: MAX_DASHBOARDS }));
  await refusal(
    createDashboard("ws_a", "one too many", full.query),
    `workspace limit reached (${MAX_DASHBOARDS} dashboards)`,
  );
  assert.deepEqual(writes(full.seen), [], "the workspace cap was weighed after the INSERT");
  assert.match(full.seen[0].sql, /pg_advisory_xact_lock/);
  assert.match(full.seen[1].sql, /count\(\*\)/);

  const packed = recordingQuery(
    engine({ row: dashRow(Array.from({ length: MAX_WIDGETS_PER_DASHBOARD }, () => widget())) }),
  );
  await refusal(
    addWidget("ws_a", "dash_00112233445566aa", newWidget(), packed.query),
    `this dashboard is full (${MAX_WIDGETS_PER_DASHBOARD} widgets)`,
  );
  assert.deepEqual(writes(packed.seen), [], "the widget cap was weighed after the UPDATE");

  const pinned = recordingQuery(engine({ row: dashRow([]), pinsElsewhere: MAX_PINNED_WIDGETS }));
  await refusal(
    addWidget("ws_a", "dash_00112233445566aa", newWidget({ pinned: true }), pinned.query),
    `overview is full (${MAX_PINNED_WIDGETS} pinned)`,
  );
  assert.deepEqual(writes(pinned.seen), [], "the pin cap was weighed after the UPDATE");
  // The overview's budget is the WORKSPACE's (D425), so the count spans every
  // OTHER dashboard and the array about to be stored — never this row twice.
  const count = pinned.seen.find((s) => s.sql.includes("jsonb_array_elements"));
  assert.match(String(count?.sql), /d\.workspace_id = \$1 AND d\.id <> \$2/);
  assert.deepEqual(count?.params, ["ws_a", "dash_00112233445566aa"]);
});

test("a mutation that cannot add a pin does not count pins", async () => {
  const { query, seen } = recordingQuery(engine());
  await addWidget("ws_a", "dash_00112233445566aa", newWidget({ pinned: false }), query);
  await removeWidget("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", query);
  await setWidgetPinned("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", false, query);

  assert.equal(seen.filter((s) => s.sql.includes("jsonb_array_elements")).length, 0);
});

// ---- the widget array: position is the index ----

test("a move past either end writes nothing and answers with the row it read", async () => {
  for (const direction of ["up", "down"] as const) {
    const one = dashRow([widget({ id: "wdg_aaaaaaaaaaaaaaaa" })]);
    const { query, seen } = recordingQuery(engine({ row: one }));
    const answer = await moveWidget("ws_a", one.id, "wdg_aaaaaaaaaaaaaaaa", direction, query);

    assert.equal(seen.length, 2, `${direction} past the end issued more than the lock and the read`);
    assert.deepEqual(writes(seen), [], `${direction} past the end wrote`);
    assert.deepEqual(answer.widgets, one.widgets);
  }
});

test("a move swaps neighbours and stores the whole array in its new order", async () => {
  const { query, seen } = recordingQuery(engine());
  await moveWidget("ws_a", "dash_00112233445566aa", "wdg_bbbbbbbbbbbbbbbb", "up", query);

  const stored = JSON.parse((writes(seen)[0].params as string[])[2]) as DashboardWidget[];
  assert.deepEqual(
    stored.map((w) => w.id),
    ["wdg_bbbbbbbbbbbbbbbb", "wdg_aaaaaaaaaaaaaaaa"],
  );
});

test("a remove drops exactly the widget named and keeps the rest in order", async () => {
  const { query, seen } = recordingQuery(engine());
  await removeWidget("ws_a", "dash_00112233445566aa", "wdg_aaaaaaaaaaaaaaaa", query);

  const stored = JSON.parse((writes(seen)[0].params as string[])[2]) as DashboardWidget[];
  assert.deepEqual(
    stored.map((w) => w.id),
    ["wdg_bbbbbbbbbbbbbbbb"],
  );
});

test("a pin toggles exactly one widget's flag", async () => {
  const { query, seen } = recordingQuery(engine());
  await setWidgetPinned("ws_a", "dash_00112233445566aa", "wdg_bbbbbbbbbbbbbbbb", true, query);

  const stored = JSON.parse((writes(seen)[0].params as string[])[2]) as DashboardWidget[];
  assert.deepEqual(
    stored.map((w) => w.pinned),
    [false, true],
  );
});

// ---- an id this workspace does not hold ----

test("a dashboard id this workspace does not hold is the D436 sentence, and nothing is written", async () => {
  const runs: [string, (query: never) => Promise<unknown>][] = [
    ["renameDashboard", (q) => renameDashboard("ws_a", "dash_ffffffffffffffff", "New", q)],
    ["addWidget", (q) => addWidget("ws_a", "dash_ffffffffffffffff", newWidget(), q)],
    ["removeWidget", (q) => removeWidget("ws_a", "dash_ffffffffffffffff", "wdg_aaaaaaaaaaaaaaaa", q)],
    ["moveWidget", (q) => moveWidget("ws_a", "dash_ffffffffffffffff", "wdg_aaaaaaaaaaaaaaaa", "up", q)],
    ["setWidgetPinned", (q) => setWidgetPinned("ws_a", "dash_ffffffffffffffff", "wdg_a", true, q)],
  ];

  for (const [name, run] of runs) {
    const { query, seen } = recordingQuery(engine({ row: null }));
    await refusal(run(query), "no dashboard with this id in your workspace");
    assert.deepEqual(writes(seen), [], `${name} wrote against an id this workspace does not hold`);
  }
});

test("a widget id this dashboard does not hold is refused, and nothing is written", async () => {
  const runs: ((query: never) => Promise<unknown>)[] = [
    (q) => removeWidget("ws_a", "dash_00112233445566aa", "wdg_ffffffffffffffff", q),
    (q) => moveWidget("ws_a", "dash_00112233445566aa", "wdg_ffffffffffffffff", "up", q),
    (q) => setWidgetPinned("ws_a", "dash_00112233445566aa", "wdg_ffffffffffffffff", true, q),
  ];

  for (const run of runs) {
    const { query, seen } = recordingQuery(engine());
    await refusal(run(query), "no widget with this id on this dashboard");
    assert.deepEqual(writes(seen), []);
  }
});

test("a delete names the workspace and the id — and answers with the workspace's list", async () => {
  const { query, seen } = recordingQuery(engine());
  await deleteDashboard("ws_a", "dash_00112233445566aa", query);

  const [remove] = writes(seen);
  assert.match(remove.sql, /DELETE FROM dashboards/);
  assert.match(remove.sql, /WHERE workspace_id = \$1 AND id = \$2/);
  assert.deepEqual(remove.params, ["ws_a", "dash_00112233445566aa"]);
});

// ---- D441: the action surface is mutations, and nothing but mutations ----

// Source text, not an import: `actions.ts` is a `"use server"` module and
// importing it here would pull `server/session.ts` and `next/headers` into a
// runner that has no request (the `explore/page.test.ts` fallback, D54(iii)).
const ACTIONS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../components/dashboards/actions.ts"),
  "utf8",
);

test("the dashboards action surface exposes the seven mutations and no read (D441)", () => {
  // A Server Function is a POST endpoint. A dashboard READ has no business
  // being one: every surface that shows dashboards reads `server/dashboards.ts`
  // on its own request, so there is one definition of what it shows — and this
  // file's store has no reachable read outside a rendered page.
  const exported = [...ACTIONS.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(exported, [
    "createDashboard",
    "renameDashboard",
    "deleteDashboard",
    "addWidget",
    "removeWidget",
    "moveWidget",
    "setWidgetPinned",
  ]);

  // The name check above would pass a read smuggled in under another name, so
  // the call itself is banned too — as is the pooled read path a read needs.
  for (const banned of ["store.listDashboards", "store.getDashboard", "queryRows"]) {
    assert.equal(
      ACTIONS.includes(banned),
      false,
      `actions.ts reaches for ${banned} — reads belong to the page (D441)`,
    );
  }
});
