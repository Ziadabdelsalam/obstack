import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { listChangeEvents, listServiceDeploys } from "./changes";
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

test("every read statement is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery();

  await listChangeEvents("ws_a", 50, query);
  await listServiceDeploys("ws_a", "checkout", 3, query);

  assert.equal(seen.length, 2);
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
