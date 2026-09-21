import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { HOSTILE_URL_VALUES } from "@/lib/hostile-url-values";
import type { QueryRows } from "./postgres";
import {
  UnknownWorkspace,
  listWorkspaceChoices,
  parseWorkspaceId,
  setActiveWorkspace,
} from "./workspaces";

// run with: npm test --workspace apps/web
//
// The switcher's store with no server (D717): the id parse is total (D68), the
// choice list is one bound read over the membership join, and the write's
// membership check is INSIDE the statement — a workspace the person does not
// belong to writes nothing and is refused by name. The real-Postgres half is
// `account.integration.test.ts`'s D717 leg, which proves the resolution really
// follows a choice and really stops following it when the membership goes.
delete process.env.BETTER_AUTH_SECRET;
delete process.env.OBSTACK_POSTGRES_DSN;

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(rows: unknown[]) {
  const seen: Statement[] = [];
  const query: QueryRows = async <Row extends QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    seen.push({ sql, params });
    return rows as Row[];
  };
  return { query, seen };
}

test("D68: parseWorkspaceId is total, and its answer is always an id or nothing", () => {
  // every spelling the repo writes: signup's, the 0004 continuity seed's, the
  // integration suites' probes
  for (const real of ["ws_0123456789abcdef", "ws_demo", "ws_f4_foreign_ab12cd34", "ws_0000000000000000ab12cd34"]) {
    assert.equal(parseWorkspaceId(real), real);
  }
  for (const value of HOSTILE_URL_VALUES) {
    const parsed = parseWorkspaceId(value as unknown as string);
    if (parsed !== null) assert.match(parsed, /^[A-Za-z0-9_-]{1,64}$/, `escaped the id domain: ${parsed}`);
  }
  for (const refused of ["", "a b", "a/b", "%00", "x".repeat(65), "ws.demo", "ws;drop"]) {
    assert.equal(parseWorkspaceId(refused), null, `accepted ${JSON.stringify(refused)}`);
  }
  assert.equal(parseWorkspaceId(undefined), null);
  assert.equal(parseWorkspaceId(null), null);
  assert.equal(parseWorkspaceId(["first", "second"] as unknown as string), null);
});

test("the choice list is one read over member → organization → workspaces, owner first, bound to the user", async () => {
  const { query, seen } = recordingQuery([
    { workspace_id: "ws_a", org_id: "org_a", org_name: "Alice", role: "owner" },
    { workspace_id: "ws_b", org_id: "org_b", org_name: "Bob", role: "member" },
  ]);
  const choices = await listWorkspaceChoices("user-1", query);

  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /FROM "member" m/);
  assert.match(seen[0].sql, /JOIN "organization" o ON o\.id = m\."organizationId"/);
  assert.match(seen[0].sql, /JOIN workspaces w ON w\.org_id = o\.id/);
  assert.match(seen[0].sql, /WHERE m\."userId" = \$1/);
  assert.match(seen[0].sql, /ORDER BY \(m\.role = 'owner'\) DESC/);
  assert.deepEqual(seen[0].params, ["user-1"]);
  assert.deepEqual(choices, [
    { workspaceId: "ws_a", orgId: "org_a", orgName: "Alice", role: "owner" },
    { workspaceId: "ws_b", orgId: "org_b", orgName: "Bob", role: "member" },
  ]);
});

test("D717: the switch's membership check is the INSERT's own source row, and one row per person", async () => {
  const { query, seen } = recordingQuery([{ workspace_id: "ws_b" }]);
  await setActiveWorkspace("user-1", "ws_b", query);

  assert.equal(seen.length, 1, "one statement: the check and the write are the same thing");
  const { sql, params } = seen[0];
  assert.match(sql, /INSERT INTO active_workspaces \(user_id, workspace_id, updated_at\)/);
  // the source row comes out of a join of the workspace to the CALLER's member rows
  assert.match(sql, /FROM workspaces w\s+JOIN "member" m ON m\."organizationId" = w\.org_id AND m\."userId" = \$1/);
  assert.match(sql, /WHERE w\.id = \$2/);
  assert.match(sql, /ON CONFLICT \(user_id\) DO UPDATE/);
  assert.match(sql, /RETURNING workspace_id/);
  assert.deepEqual(params, ["user-1", "ws_b"]);
});

test("D717: a switch that wrote no row is UnknownWorkspace, never a silent success", async () => {
  const { query } = recordingQuery([]);
  await assert.rejects(setActiveWorkspace("user-1", "ws_someone_elses", query), (error: unknown) => {
    assert.ok(error instanceof UnknownWorkspace);
    assert.equal((error as Error).name, "UnknownWorkspace");
    return true;
  });
});
