import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { deleteSavedView, listSavedViews, saveSavedView } from "./saved-views";
import { getPool, queryRows } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// The rows-actually-disjoint half of the saved-views store (D130): that a view
// saved in one workspace is INVISIBLE to another, and that neither an UPSERT nor
// a DELETE issued for one workspace can reach the identically named view in the
// other. `saved-views.test.ts` proves the same predicates are in the SQL with no
// Postgres at all and stays that way (D130(1)); this file proves Postgres agrees
// — the UNIQUE key really is `(workspace_id, surface, name)` and the WHERE
// clauses really do partition the table.
//
// D36 class, and the skip condition is deliberately NARROW: this file self-skips
// only when `OBSTACK_TEST_POSTGRES_DSN` is UNSET. It does not probe for
// reachability first, because a probe that skips on a refused connection is
// exactly the hollow green D36 exists to prevent — a DSN that names a dead port
// or an unmigrated database FAILS here, loudly, naming what it dialled. The
// check is synchronous and stated in the test options for the same reason:
// there is no window in which this file can do work and then decide to skip.
//
// The schema is NOT applied here. `services/ingest/pgmigrations/*.sql` applied
// in filename order by the ingest binary's migrator is the ONE schema path (K1);
// this file only writes and reads rows. `web.yml` sets the DSN at the compose
// Postgres it already boots, so the skip trap genuinely dials.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

// `postgres.ts` builds its pool lazily on the first query (D114), so pointing
// the app's own read path at the test DSN here is enough: everything below goes
// through `queryRows`, the same parameterized path the server actions use, and
// nothing talks to this database through a side channel.
if (DSN) process.env.OBSTACK_POSTGRES_DSN = DSN;

/** host:port of the DSN, for failure messages — never its password. */
function target(): string {
  try {
    const url = new URL(DSN as string);
    return `${url.host}${url.pathname}`;
  } catch {
    return "the configured DSN";
  }
}

after(async () => {
  // An idle pg pool holds the event loop open and the runner would never exit.
  if (DSN) await getPool().end();
});

/**
 * A fresh pair of workspaces for one test, dropped afterwards. The ids carry a
 * random suffix because CI runs this against the compose Postgres a signup drive
 * also writes to: a fixed id would collide with a rerun and a global DELETE
 * would take somebody else's rows with it. Everything asserted below is scoped
 * to this pair.
 */
async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_t6a_${tag}`;
  const b = `ws_t6b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [
    a,
    `org_t6a_${tag}`,
    b,
    `org_t6b_${tag}`,
  ]);
  try {
    await run(a, b);
  } finally {
    // ON DELETE CASCADE takes the views with them (D116) — asserted below.
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

/** Rows in the table for one workspace, counted directly rather than through the store. */
async function rowCount(workspaceId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(
    `SELECT count(*)::text AS n FROM saved_views WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(row.n);
}

test("the DSN this run was given answers, and it holds the migrated schema", { skip }, async () => {
  // First contact. A refused connection or a missing table surfaces HERE, with
  // the address in the message, instead of as a puzzling failure inside a
  // property test — and never as a skip.
  try {
    assert.equal(await rowCount(`ws_t6_absent_${randomBytes(4).toString("hex")}`), 0);
  } catch (error) {
    assert.fail(
      `OBSTACK_TEST_POSTGRES_DSN is set but ${target()} did not answer a read of saved_views — ` +
        `an integration test with a DSN never degrades to a pass; apply ` +
        `services/ingest/pgmigrations in filename order and check the port: ${String(error)}`,
    );
  }
});

test("a view saved in one workspace is invisible to the other", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const filters = { status: "error", range: "24h" };
    // The page key rides in and must not ride back out (D47(ii)/D53) — through
    // a real JSONB column this time, not a recorded parameter.
    await saveSavedView(a, "traces", "escalations", { ...filters, page: "3" }, queryRows);

    assert.deepEqual(await listSavedViews(a, "traces", queryRows), [
      { name: "escalations", filters },
    ]);
    assert.deepEqual(await listSavedViews(b, "traces", queryRows), []);
    // The claim is about ROWS, not about what the read path chose to return.
    assert.equal(await rowCount(a), 1);
    assert.equal(await rowCount(b), 0);
  });
});

test("the same name in two workspaces is two rows, and neither UPSERT reaches the other", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    await saveSavedView(a, "traces", "escalations", { status: "error" }, queryRows);
    await saveSavedView(b, "traces", "escalations", { status: "ok" }, queryRows);

    // The unique key is (workspace_id, surface, name): the second save is a new
    // row, not a conflict with the first.
    assert.equal(await rowCount(a), 1);
    assert.equal(await rowCount(b), 1);

    // Save-over-name in b replaces b's view and leaves a's alone — the
    // cross-tenant UPDATE refusal, which is the same property as disjointness
    // read from the write side.
    await saveSavedView(b, "traces", "escalations", { status: "ok", minMs: "5000" }, queryRows);
    assert.deepEqual(await listSavedViews(b, "traces", queryRows), [
      { name: "escalations", filters: { status: "ok", minMs: "5000" } },
    ]);
    assert.deepEqual(await listSavedViews(a, "traces", queryRows), [
      { name: "escalations", filters: { status: "error" } },
    ]);
    assert.equal(await rowCount(b), 1, "save-over-name added a row instead of replacing one");
  });
});

test("a delete issued for one workspace cannot reach the other's identically named view", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    await saveSavedView(a, "traces", "escalations", { status: "error" }, queryRows);
    await saveSavedView(b, "traces", "escalations", { status: "ok" }, queryRows);

    assert.deepEqual(await deleteSavedView(b, "traces", "escalations", queryRows), []);
    assert.equal(await rowCount(b), 0);
    // Control: the delete was real — it removed b's row — and a's survived it.
    assert.deepEqual(await listSavedViews(a, "traces", queryRows), [
      { name: "escalations", filters: { status: "error" } },
    ]);
    assert.equal(await rowCount(a), 1);
  });
});

test("surfaces are separate namespaces inside one workspace, and still scoped to it", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    await saveSavedView(a, "traces", "escalations", { status: "error" }, queryRows);
    await saveSavedView(a, "logs", "escalations", { sev: "error" }, queryRows);

    assert.equal(await rowCount(a), 2, "the CHECK's two surfaces share one name and one workspace");
    assert.deepEqual(await listSavedViews(a, "logs", queryRows), [
      { name: "escalations", filters: { sev: "error" } },
    ]);
    assert.deepEqual(await listSavedViews(b, "logs", queryRows), []);
  });
});

test("dropping a workspace takes its views with it (D116's in-set foreign key)", { skip }, async () => {
  const tag = randomBytes(6).toString("hex");
  const doomed = `ws_t6c_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [doomed, `org_t6c_${tag}`]);
  await saveSavedView(doomed, "traces", "escalations", { status: "error" }, queryRows);
  assert.equal(await rowCount(doomed), 1);

  await queryRows(`DELETE FROM workspaces WHERE id = $1`, [doomed]);
  // No orphan rows to clean up later: a view means nothing without its
  // workspace, which is why the FK is in-set and required.
  assert.equal(await rowCount(doomed), 0);
});
