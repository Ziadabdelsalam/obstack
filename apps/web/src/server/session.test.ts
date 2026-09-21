import assert from "node:assert/strict";
import test from "node:test";
import { cache } from "react";
import type { QueryResultRow } from "pg";
import { resolveSessionContext } from "./session";
import type { QueryRows } from "./postgres";

// run with: npm test --workspace apps/web
//
// `getSessionContext` is two things: a better-auth session read that needs a
// request, and the workspace resolution below that needs only rows. The read
// path is a parameter (D113's rule, applied to Postgres) so this half runs with
// neither a request nor a server — which is also the shape D114's byte
// invariance depends on: importing this module must not touch Postgres.

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

test("a member row and its org's first workspace become the session context", async () => {
  const { query, seen } = recordingQuery([{ org_id: "org_a", workspace_id: "ws_a" }]);

  assert.deepEqual(await resolveSessionContext("user-1", query), {
    userId: "user-1",
    orgId: "org_a",
    workspaceId: "ws_a",
  });
  assert.deepEqual(seen[0].params, ["user-1"]);
});

test("the active workspace is the org's first by D114's ordering, and only the first", async () => {
  const { query, seen } = recordingQuery([{ org_id: "org_a", workspace_id: "ws_a" }]);
  await resolveSessionContext("user-1", query);

  // "Active" is this ORDER BY, whole (D717 over D114): the chosen row first,
  // then an owner row before a member row, then the org's first workspace by
  // `created_at, id`. A resolution that dropped any key would answer
  // differently the first time the case it decides arises — long after the
  // code was written.
  assert.match(
    seen[0].sql,
    /ORDER BY \(a\.workspace_id IS NOT NULL\) DESC, \(m\.role = 'owner'\) DESC, w\.created_at, w\.id/,
  );
  assert.match(seen[0].sql, /LIMIT 1/);
});

test("the org comes from the member table, never from the session cookie", async () => {
  const { query, seen } = recordingQuery([{ org_id: "org_a", workspace_id: "ws_a" }]);
  await resolveSessionContext("user-1", query);

  assert.match(seen[0].sql, /FROM "member" m/);
  assert.match(seen[0].sql, /WHERE m\."userId" = \$1/);
});

test("the session pins to the org the user OWNS, not merely belongs to (D120)", async () => {
  const { query, seen } = recordingQuery([{ org_id: "org_a", workspace_id: "ws_a" }]);
  await resolveSessionContext("user-1", query);

  // Membership is not identity. Without this pin, a user who ends up in a second
  // org — S3.2's invitations, or any org endpoint that stops being refused —
  // could have their whole session resolve to someone else's workspace because
  // that row happened to sort first. Since D717 the pin is the DEFAULT rather
  // than a filter: an owner row outranks a member row unless the person chose
  // otherwise. Removing `(m.role = 'owner') DESC` from ACTIVE_WORKSPACE_SQL
  // turns this red.
  assert.match(seen[0].sql, /m\.role = 'owner'/);
});

test("D717: a chosen workspace outranks the default, and only while the membership that admits it holds", async () => {
  const { query, seen } = recordingQuery([{ org_id: "org_b", workspace_id: "ws_b" }]);
  await resolveSessionContext("user-1", query);

  // The choice is joined to the MEMBERSHIP row's workspace, on the user and the
  // workspace both: a row in `active_workspaces` pointing at an organization
  // the person has left matches no membership row, so it sorts nowhere and the
  // owner default answers. The write side checks membership too
  // (`server/workspaces.ts`); this is the read side not trusting it.
  assert.match(
    seen[0].sql,
    /LEFT JOIN active_workspaces a ON a\.user_id = m\."userId" AND a\.workspace_id = w\.id/,
  );
  // ...and the choice is the FIRST sort key, ahead of the owner pin.
  const orderBy = seen[0].sql.slice(seen[0].sql.indexOf("ORDER BY"));
  assert.ok(orderBy.indexOf("a.workspace_id IS NOT NULL") < orderBy.indexOf("m.role = 'owner'"));
});

test("a signed-in user with no workspace is a half-state and refuses loudly", async () => {
  const { query } = recordingQuery([]);

  // Returning null here would read as "not signed in" and bounce the user back
  // to /login forever; D117's contract says this row cannot exist, so saying so
  // is the only honest answer.
  await assert.rejects(resolveSessionContext("user-9", query), /user-9 has no workspace/);
});

// ---- D134: the scope `getSessionContext` is memoized in ----
//
// `getSessionContext` is wrapped in React's `cache`, whose memo lives on the
// render's cache root — per request, never wider. That scope is a TENANCY
// property here, not a performance one, so it is proven both ways and neither
// half is optional. The half that needs a server is in F7's report: one
// signed-in /app render went from 2 workspace reads to 1 (two readers sharing),
// while 20 concurrent renders across two tenants produced exactly 20 reads and
// zero cross-tenant renders (nothing shared between requests).
//
// The half that belongs here is the mechanism the module leans on, asserted
// against the INSTALLED react rather than its documentation.

test("D134: react's cache() is a pass-through with no render in scope", async () => {
  let calls = 0;
  const probe = cache(async (key: string) => {
    calls += 1;
    return key;
  });

  assert.equal(await probe("same"), "same");
  assert.equal(await probe("same"), "same");

  // Two calls, two invocations. A `cache` that memoized here would be memoizing
  // process-wide — which is exactly the shape that hands one stranger another
  // stranger's workspace — and it would also change the semantics of the
  // callers that run outside a render pass (the saved-views server action, this
  // suite): they must always see current state.
  assert.equal(calls, 2, "cache() memoized outside a render — the memo is no longer request-scoped");
});
