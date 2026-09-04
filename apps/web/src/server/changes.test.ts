import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResultRow } from "pg";
import {
  listChangeEvents,
  listChangeEventsInLeadIn,
  listChangeEventsInWindow,
  listServiceDeploys,
} from "./changes";
import type { QueryRows } from "./postgres";

// run with: cd apps/web && npx tsx --conditions react-server --test src/server/changes.test.ts
//
// The changes store's contract with no Postgres at all (the `alerts.test.ts`
// hermetic half): every read is bound to the workspace it was handed, the
// feed orders by the event's own time and never by receipt, the deploys read
// is scoped to the kind and the service, and the module writes NOTHING.
// Whether the rows are actually disjoint across two workspaces is
// `changes.integration.test.ts`; this file proves what the statements SAY.

type Statement = { sql: string; params?: unknown[] };

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

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** One incident's window and the lead-in hour before it (D535). */
const LEAD_IN_START = "2026-09-04T12:00:00.000Z";
const WINDOW_START = "2026-09-04T13:00:00.000Z";
const WINDOW_END = "2026-09-04T13:30:00.000Z";

// The count was 2 through S7.2 and is 4 from S7.4: the module gained BOTH of
// D535's timeline reads, not one. (The packet's D530 says this pin "moves to 3"
// — that sentence was written before D535 split the changes leg into an
// in-window read and a separately-capped lead-in read, and D535 is the later,
// governing ruling. Recorded as a plan correction: 2 → 4, not 2 → 3.)
test("every read statement is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery();

  await listChangeEvents("ws_a", 50, query);
  await listServiceDeploys("ws_a", "checkout", 3, query);
  await listChangeEventsInWindow("ws_a", WINDOW_START, WINDOW_END, 51, query);
  await listChangeEventsInLeadIn("ws_a", LEAD_IN_START, WINDOW_START, 21, query);

  assert.equal(seen.length, 4, "this module's read count changed — every one of them must still scope by workspace");
  for (const { sql, params } of seen) {
    assert.match(sql, /WHERE workspace_id = \$1/, `a read does not scope by workspace: ${sql}`);
    assert.equal(params?.[0], "ws_a", `a read bound ${String(params?.[0])} as its workspace`);
  }
});

test("the feed orders by the event's own time, never by receipt", async () => {
  const { query, seen } = recordingQuery();
  await listChangeEvents("ws_a", 50, query);
  const [{ sql }] = seen;
  assert.match(sql, /ORDER BY at DESC, id DESC/);
  assert.doesNotMatch(sql, /created_at/, "the feed must not order or filter by created_at");
});

test("the deploys read is scoped to kind deploy and the named service", async () => {
  const { query, seen } = recordingQuery();
  await listServiceDeploys("ws_a", "checkout", 3, query);
  const [{ sql, params }] = seen;
  assert.match(sql, /kind = 'deploy'/);
  assert.match(sql, /service = \$2/);
  assert.deepEqual(params, ["ws_a", "checkout", 3]);
});

test("a limit is a positive integer or it is 1", async () => {
  for (const [given, want] of [
    [0, 1],
    [-5, 1],
    [2.7, 2],
    [Number.NaN, 1],
    [50, 50],
  ] as const) {
    const { query, seen } = recordingQuery();
    await listChangeEvents("ws_a", given, query);
    assert.equal(seen[0]?.params?.[1], want, `limit ${given} bound as ${String(seen[0]?.params?.[1])}`);
  }
});

test("rows map to the §0 contract: ISO UTC times, a folded link or null", async () => {
  const at = new Date("2026-09-02T09:00:00Z");
  const rows = [
    {
      id: "chg_1",
      kind: "deploy",
      at,
      title: "deploy 8963ae2",
      detail: "",
      who: "ziad",
      service: "checkout",
      ref: "8963ae2",
      source: "github-actions",
      link_label: "workflow run",
      link_href: "https://github.com/o/r/actions/runs/1",
    },
    {
      id: "chg_2",
      kind: "config",
      at,
      title: "flag flipped",
      detail: "a\nb",
      who: "",
      service: null,
      ref: null,
      source: null,
      link_label: null,
      link_href: null,
    },
  ];
  const { query } = recordingQuery(() => rows);

  const events = await listChangeEvents("ws_a", 50, query);
  assert.deepEqual(events, [
    {
      id: "chg_1",
      kind: "deploy",
      at: "2026-09-02T09:00:00.000Z",
      title: "deploy 8963ae2",
      detail: "",
      who: "ziad",
      service: "checkout",
      ref: "8963ae2",
      source: "github-actions",
      link: { label: "workflow run", href: "https://github.com/o/r/actions/runs/1" },
    },
    {
      id: "chg_2",
      kind: "config",
      at: "2026-09-02T09:00:00.000Z",
      title: "flag flipped",
      detail: "a\nb",
      who: "",
      service: null,
      ref: null,
      source: null,
      link: null,
    },
  ]);

  const deploys = await listServiceDeploys("ws_a", "checkout", 3, query);
  assert.deepEqual(deploys[0], {
    id: "chg_1",
    ref: "8963ae2",
    at: "2026-09-02T09:00:00.000Z",
    who: "ziad",
    title: "deploy 8963ae2",
    link: { label: "workflow run", href: "https://github.com/o/r/actions/runs/1" },
  });
});

// ---- S7.4: the incident timeline's changes legs (D530/D534/D535) -------------

/** A row as Postgres hands it back, so a leg's mapping is proven against the
 *  same shape the feed's own test uses. */
const eventRow = (over: Record<string, unknown> = {}) => ({
  id: "chg_1",
  kind: "deploy",
  at: new Date("2026-09-04T13:04:00Z"),
  title: "deploy 8963ae2",
  detail: "",
  who: "ziad",
  service: null,
  ref: null,
  source: null,
  link_label: null,
  link_href: null,
  ...over,
});

const orderBy = (sql: string): string => sql.split("\n").filter((line) => line.includes("ORDER BY")).join("");

test("no read in this module names created_at — every statement is on the event's own time", async () => {
  const { query, seen } = recordingQuery();

  await listChangeEvents("ws_a", 50, query);
  await listServiceDeploys("ws_a", "checkout", 3, query);
  await listChangeEventsInWindow("ws_a", WINDOW_START, WINDOW_END, 51, query);
  await listChangeEventsInLeadIn("ws_a", LEAD_IN_START, WINDOW_START, 21, query);

  assert.equal(seen.length, 4);
  for (const { sql } of seen) {
    assert.doesNotMatch(sql, /created_at/, `a statement orders or filters by receipt: ${sql}`);
    assert.match(sql, /\bat\b/, `a statement does not name the event's own time: ${sql}`);
  }
});

test("the in-window leg is half-open [from, until) and reads FORWARD", async () => {
  const { query, seen } = recordingQuery();
  await listChangeEventsInWindow("ws_a", WINDOW_START, WINDOW_END, 51, query);
  const [{ sql, params }] = seen;

  assert.match(sql, /at >= \$2 AND at < \$3/, "the window must be half-open on `at`");
  assert.doesNotMatch(sql, /BETWEEN/, "BETWEEN is closed on both ends: two adjacent incidents would both claim the boundary row");
  assert.doesNotMatch(sql, /at <= \$3/, "an inclusive upper bound is D534's exact defect");
  assert.equal(orderBy(sql), "   ORDER BY at, id", "a timeline reads forward, ties broken by id");
  assert.match(sql, /LIMIT \$4/);
  assert.deepEqual(params, ["ws_a", WINDOW_START, WINDOW_END, 51]);
  assert.doesNotMatch(sql, /now\(\)/, "the clock is sampled once in TS and bound (D534) — never a second one in SQL");
});

test("the lead-in is its OWN statement with its OWN cap, and differs from the in-window read ONLY in its order", async () => {
  const { query, seen } = recordingQuery();
  await listChangeEventsInWindow("ws_a", WINDOW_START, WINDOW_END, 51, query);
  await listChangeEventsInLeadIn("ws_a", LEAD_IN_START, WINDOW_START, 21, query);
  const [window, leadIn] = seen;

  // D535: one ASC leg with one cap lets the lead-in band eat the whole budget,
  // so the lead-in is a SECOND read with a SECOND limit — proven here by the
  // two statements being distinct and each binding its own number.
  assert.notEqual(window.sql, leadIn.sql);
  assert.equal(window.params?.[3], 51);
  assert.equal(leadIn.params?.[3], 21);
  assert.deepEqual(leadIn.params, ["ws_a", LEAD_IN_START, WINDOW_START, 21]);

  // Same predicate, opposite order: everything but the ORDER BY is identical,
  // so the lead-in can never drift into a different window shape.
  assert.equal(
    window.sql.replace(orderBy(window.sql), ""),
    leadIn.sql.replace(orderBy(leadIn.sql), ""),
    "the two legs must read the same half-open window on the same projection",
  );
  assert.equal(orderBy(leadIn.sql), "   ORDER BY at DESC, id DESC", "DESC is what makes the cap keep the changes NEAREST the incident");
  assert.match(leadIn.sql, /at >= \$2 AND at < \$3/);
});

test("the lead-in returns its rows NEWEST-first — the caller reverses, not the store", async () => {
  const nearest = eventRow({ id: "chg_near", at: new Date("2026-09-04T12:59:00Z"), title: "nearest" });
  const farthest = eventRow({ id: "chg_far", at: new Date("2026-09-04T12:01:00Z"), title: "farthest" });
  const { query } = recordingQuery(() => [nearest, farthest]);

  const rows = await listChangeEventsInLeadIn("ws_a", LEAD_IN_START, WINDOW_START, 21, query);
  assert.deepEqual(rows.map((e) => e.title), ["nearest", "farthest"]);
  // D536's probe row is the LAST element in this order, which is where a
  // caller's slice(0, cap) drops it; reversed here it would be the first, and
  // that slice would throw away the change nearest the incident instead.
  assert.equal(rows.at(-1)?.title, "farthest");
});

test("both timeline legs clamp their limit by the same rule as the feed", async () => {
  for (const [given, want] of [
    [0, 1],
    [-5, 1],
    [2.7, 2],
    [Number.NaN, 1],
    [51, 51],
  ] as const) {
    const { query, seen } = recordingQuery();
    await listChangeEventsInWindow("ws_a", WINDOW_START, WINDOW_END, given, query);
    await listChangeEventsInLeadIn("ws_a", LEAD_IN_START, WINDOW_START, given, query);
    assert.equal(seen[0]?.params?.[3], want, `in-window limit ${given} bound as ${String(seen[0]?.params?.[3])}`);
    assert.equal(seen[1]?.params?.[3], want, `lead-in limit ${given} bound as ${String(seen[1]?.params?.[3])}`);
  }
});

test("both timeline legs map rows through the same one point as the feed", async () => {
  const row = eventRow({ id: "chg_1", at: new Date("2026-09-04T13:04:00Z"), title: "deploy 8963ae2", service: "checkout" });
  const { query } = recordingQuery(() => [row]);

  const want = {
    id: "chg_1",
    kind: "deploy",
    at: "2026-09-04T13:04:00.000Z",
    title: "deploy 8963ae2",
    detail: "",
    who: "ziad",
    service: "checkout",
    ref: null,
    source: null,
    link: null,
  };
  assert.deepEqual(await listChangeEventsInWindow("ws_a", WINDOW_START, WINDOW_END, 51, query), [want]);
  assert.deepEqual(await listChangeEventsInLeadIn("ws_a", LEAD_IN_START, WINDOW_START, 21, query), [want]);
});

test("the module is reads only: no write statement, no lock, no actions file (packet §0)", () => {
  const source = readFileSync(path.join(HERE, "changes.ts"), "utf8");
  assert.doesNotMatch(source, /\b(INSERT|UPDATE|DELETE)\b/, "changes.ts must not write");
  assert.doesNotMatch(source, /lockWorkspace|withTransaction|TxQuery/, "a read-only module takes no lock");
  assert.equal(
    existsSync(path.join(HERE, "..", "components", "changes", "actions.ts")),
    false,
    "v1 has no manual entry: components/changes/actions.ts must not exist",
  );
});
