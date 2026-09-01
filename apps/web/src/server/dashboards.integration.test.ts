import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import {
  MAX_DASHBOARDS,
  MAX_PINNED_WIDGETS,
  MAX_WIDGETS_PER_DASHBOARD,
  type Dashboard,
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
import { getPool, queryRows, withTransaction } from "./postgres";

// run with: docker compose -f deploy/compose/docker-compose.yml up -d --wait postgres ingest
// then:     OBSTACK_TEST_POSTGRES_DSN=postgres://obstack:obstack_postgres_dev@127.0.0.1:5432/obstack \
//           npm test --workspace apps/web
//
// The rows-actually-disjoint half of the dashboards store (D130/D432): that a
// dashboard created in one workspace is INVISIBLE to another, and that no
// mutation issued for one workspace can reach the identically named dashboard —
// holding widgets with the IDENTICAL ids (S6.2-L2) — in the other. Both
// workspaces are deliberately made as confusable as the schema allows: same
// dashboard name, same widget ids, same titles. Only the dashboard id differs,
// because it is the primary key.
//
// `dashboards.test.ts` proves the predicates are in the SQL with no Postgres at
// all and stays that way (D130(1)); this file proves Postgres agrees — the
// UNIQUE key really is `(workspace_id, name)`, a duplicate name really is
// refused rather than upserted (D424), the caps really hold, and the JSONB
// widget array really round-trips.
//
// D36 class, and the skip condition is deliberately NARROW: this file self-skips
// only when `OBSTACK_TEST_POSTGRES_DSN` is UNSET. It does not probe for
// reachability first, because a probe that skips on a refused connection is
// exactly the hollow green D36 exists to prevent — a DSN that names a dead port
// or an unmigrated database FAILS here, loudly, naming what it dialled.
//
// The schema is NOT applied here. `services/ingest/pgmigrations/*.sql` applied in
// filename order by the ingest binary's migrator is the ONE schema path (K1);
// this file only writes and reads rows.

const DSN = process.env.OBSTACK_TEST_POSTGRES_DSN;

const skip = DSN
  ? undefined
  : "OBSTACK_TEST_POSTGRES_DSN is unset — no Postgres to dial (deploy/compose/README.md)";

// `postgres.ts` builds its pool lazily on the first query (D114), so pointing the
// app's own read path at the test DSN here is enough: everything below goes
// through `queryRows`/`withTransaction`, the same paths the server actions use.
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

/** A widget payload; `groupBy` null and `timeseries` so every field is legal as-is. */
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

/** A refusal is judged by its class AND its exact sentence (D430/D436). */
async function refusal(work: Promise<unknown>, sentence: string): Promise<void> {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof DashboardRefusal, `not a DashboardRefusal: ${String(error)}`);
    assert.equal((error as Error).message, sentence);
    return true;
  });
}

/**
 * A fresh pair of workspaces for one test, dropped afterwards. The ids carry a
 * random suffix because CI runs this against the compose Postgres a signup drive
 * also writes to: a fixed id would collide with a rerun and a global DELETE
 * would take somebody else's rows with it.
 */
async function withWorkspacePair(run: (a: string, b: string) => Promise<void>): Promise<void> {
  const tag = randomBytes(6).toString("hex");
  const a = `ws_t1a_${tag}`;
  const b = `ws_t1b_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2), ($3, $4)`, [
    a,
    `org_t1a_${tag}`,
    b,
    `org_t1b_${tag}`,
  ]);
  try {
    await run(a, b);
  } finally {
    // ON DELETE CASCADE takes the dashboards with them (D424) — asserted below.
    await queryRows(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [a, b]);
  }
}

/** Rows in the table for one workspace, counted directly rather than through the store. */
async function rowCount(workspaceId: string): Promise<number> {
  const [row] = await queryRows<{ n: string }>(
    `SELECT count(*)::text AS n FROM dashboards WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(row.n);
}

/**
 * The confusable fixture: both workspaces get a dashboard under the SAME name,
 * each holding a widget with the SAME id and title. Widget ids are
 * app-generated, so the collision is forced by one fixture statement after the
 * store wrote both rows — which is the point: a mutation must be judged by
 * (workspace_id, dashboard id), and nothing else in the row can be used to tell
 * the two apart.
 */
async function confusablePair(
  a: string,
  b: string,
  name: string,
): Promise<{ alice: Dashboard; bob: Dashboard; widgetId: string }> {
  const aRow = await withTransaction((q) => createDashboard(a, name, q));
  const bRow = await withTransaction((q) => createDashboard(b, name, q));
  const alice = await withTransaction((q) => addWidget(a, aRow.id, newWidget(), q));
  await withTransaction((q) => addWidget(b, bRow.id, newWidget(), q));

  await queryRows(`UPDATE dashboards SET widgets = $2::jsonb WHERE id = $1`, [
    bRow.id,
    JSON.stringify(alice.widgets),
  ]);
  const bob = (await getDashboard(b, bRow.id, queryRows)) as Dashboard;

  assert.notEqual(alice.id, bob.id, "two dashboards cannot share a primary key");
  assert.equal(alice.name, bob.name);
  assert.deepEqual(alice.widgets, bob.widgets, "the fixture is not confusable enough");
  return { alice, bob, widgetId: alice.widgets[0].id };
}

test("the DSN this run was given answers, and it holds the migrated schema", { skip }, async () => {
  // First contact. A refused connection or a missing table surfaces HERE, with
  // the address in the message, instead of as a puzzling failure inside a
  // property test — and never as a skip.
  try {
    assert.equal(await rowCount(`ws_t1_absent_${randomBytes(4).toString("hex")}`), 0);
  } catch (error) {
    assert.fail(
      `OBSTACK_TEST_POSTGRES_DSN is set but ${target()} did not answer a read of dashboards — ` +
        `an integration test with a DSN never degrades to a pass; apply ` +
        `services/ingest/pgmigrations in filename order and check the port: ${String(error)}`,
    );
  }
});

test("a dashboard created in one workspace is invisible to the other", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const name = `Latency ${randomBytes(4).toString("hex")}`;
    const { alice, bob } = await confusablePair(a, b, name);

    assert.deepEqual(
      (await listDashboards(a, queryRows)).map((d) => d.id),
      [alice.id],
    );
    assert.deepEqual(
      (await listDashboards(b, queryRows)).map((d) => d.id),
      [bob.id],
    );
    // The read that matters: bob naming alice's id gets nothing, not her row.
    assert.equal(await getDashboard(b, alice.id, queryRows), null);
    assert.equal(await getDashboard(a, bob.id, queryRows), null);
    // The claim is about ROWS, not about what the read path chose to return.
    assert.equal(await rowCount(a), 1);
    assert.equal(await rowCount(b), 1);
  });
});

test("the workspace predicate is what partitions the table — dropped, the same read leaks", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const name = `Latency ${randomBytes(4).toString("hex")}`;
    await confusablePair(a, b, name);

    // The store's own predicate, and the same read with `workspace_id = $1`
    // removed. Two rows come back from the second: the scoping is doing real
    // work, and this file would notice if it stopped.
    const scoped = await queryRows<{ id: string }>(
      `SELECT id FROM dashboards WHERE workspace_id = $1 AND name = $2`,
      [a, name],
    );
    const unscoped = await queryRows<{ id: string }>(`SELECT id FROM dashboards WHERE name = $1`, [
      name,
    ]);
    assert.equal(scoped.length, 1);
    assert.equal(unscoped.length, 2, "the fixture never actually put a row in each workspace");
  });
});

test("no mutation issued for one workspace can reach the other's identically named dashboard", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const name = `Latency ${randomBytes(4).toString("hex")}`;
    const { alice, widgetId } = await confusablePair(a, b, name);
    const gone = "no dashboard with this id in your workspace";

    // Every mutation, each naming alice's dashboard id and her widget id from
    // INSIDE bob's workspace. The widget id exists in bob's own row too, so a
    // store that keyed on it rather than on (workspace, dashboard) would find
    // something to do here.
    await refusal(withTransaction((q) => renameDashboard(b, alice.id, "Hijacked", q)), gone);
    await refusal(withTransaction((q) => addWidget(b, alice.id, newWidget(), q)), gone);
    await refusal(withTransaction((q) => removeWidget(b, alice.id, widgetId, q)), gone);
    await refusal(withTransaction((q) => moveWidget(b, alice.id, widgetId, "down", q)), gone);
    await refusal(withTransaction((q) => setWidgetPinned(b, alice.id, widgetId, true, q)), gone);

    // A delete does not refuse — it matches no row and answers with bob's own
    // list, which is all a foreign id may learn.
    const bobsList = await withTransaction((q) => deleteDashboard(b, alice.id, q));
    assert.equal(bobsList.length, 1, "bob's own dashboard went with a delete aimed at alice's");

    // Alice's row survived all six untouched, name, widgets and pins included.
    assert.deepEqual(await getDashboard(a, alice.id, queryRows), alice);
    assert.equal(await rowCount(a), 1);
  });
});

test("every mutation is real inside its own workspace, and none of it crosses", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const name = `Latency ${randomBytes(4).toString("hex")}`;
    const { alice, bob, widgetId } = await confusablePair(a, b, name);

    const two = await withTransaction((q) => addWidget(a, alice.id, newWidget({ title: "errors" }), q));
    assert.deepEqual(
      two.widgets.map((w) => w.title),
      ["p90 latency", "errors"],
    );
    // The array is ordered and position is the index (D424).
    const moved = await withTransaction((q) => moveWidget(a, alice.id, widgetId, "down", q));
    assert.deepEqual(
      moved.widgets.map((w) => w.title),
      ["errors", "p90 latency"],
    );
    const pinned = await withTransaction((q) => setWidgetPinned(a, alice.id, widgetId, true, q));
    assert.deepEqual(
      pinned.widgets.map((w) => w.pinned),
      [false, true],
    );
    const renamed = await withTransaction((q) => renameDashboard(a, alice.id, `${name} v2`, q));
    assert.equal(renamed.name, `${name} v2`);
    // Every mutation bumps the row's stamp, so a surface can date what it shows.
    assert.ok(renamed.updatedAt > alice.updatedAt, `${renamed.updatedAt} !> ${alice.updatedAt}`);

    const left = await withTransaction((q) => removeWidget(a, alice.id, widgetId, q));
    assert.deepEqual(
      left.widgets.map((w) => w.title),
      ["errors"],
    );

    // Bob's identically named row, with the identically identified widget, is
    // exactly as it was: none of the six touched it.
    assert.deepEqual(await getDashboard(b, bob.id, queryRows), bob);
  });
});

test("a name is the identity within a workspace, and a taken one is refused rather than upserted", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const name = `Latency ${randomBytes(4).toString("hex")}`;
    const { alice } = await confusablePair(a, b, name);

    // The UNIQUE key is (workspace_id, name): the same name in the other
    // workspace was a second ROW above, and a second one HERE is refused with
    // the sentence — never an upsert that would replace alice's widgets.
    await refusal(
      withTransaction((q) => createDashboard(a, name, q)),
      `a dashboard named “${name}” already exists`,
    );
    // Renaming onto a taken name is the same refusal, from the other direction.
    const other = await withTransaction((q) => createDashboard(a, `${name} other`, q));
    await refusal(
      withTransaction((q) => renameDashboard(a, other.id, name, q)),
      `a dashboard named “${name}” already exists`,
    );

    assert.equal(await rowCount(a), 2, "a refused create still wrote a row");
    assert.deepEqual(await getDashboard(a, alice.id, queryRows), alice, "an upsert replaced the widgets");
  });
});

test("the caps hold against the store, with the sentences the surface prints", { skip }, async () => {
  await withWorkspacePair(async (a, b) => {
    const tag = randomBytes(4).toString("hex");

    // 13th widget on one dashboard.
    const board = await withTransaction((q) => createDashboard(a, `packed ${tag}`, q));
    for (let i = 0; i < MAX_WIDGETS_PER_DASHBOARD; i += 1) {
      await withTransaction((q) => addWidget(a, board.id, newWidget({ title: `w${i}` }), q));
    }
    await refusal(
      withTransaction((q) => addWidget(a, board.id, newWidget({ title: "one more" }), q)),
      `this dashboard is full (${MAX_WIDGETS_PER_DASHBOARD} widgets)`,
    );
    assert.equal((await getDashboard(a, board.id, queryRows))?.widgets.length, MAX_WIDGETS_PER_DASHBOARD);

    // 9th pin, counted across the WORKSPACE (D425) — eight on the first
    // dashboard, the ninth attempted on a second one, which is the only shape
    // that proves the budget is not per-row.
    const held = (await getDashboard(a, board.id, queryRows)) as Dashboard;
    for (let i = 0; i < MAX_PINNED_WIDGETS; i += 1) {
      await withTransaction((q) => setWidgetPinned(a, board.id, held.widgets[i].id, true, q));
    }
    const second = await withTransaction((q) => createDashboard(a, `elsewhere ${tag}`, q));
    const withOne = await withTransaction((q) => addWidget(a, second.id, newWidget(), q));
    await refusal(
      withTransaction((q) => setWidgetPinned(a, second.id, withOne.widgets[0].id, true, q)),
      `overview is full (${MAX_PINNED_WIDGETS} pinned)`,
    );
    // Adding an already-pinned widget's dashboard-mate unpinned is still fine.
    await withTransaction((q) => addWidget(a, second.id, newWidget({ title: "unpinned" }), q));
    // …and the same pin succeeds in the OTHER workspace: the budget is per tenant.
    const bobs = await withTransaction((q) => createDashboard(b, `elsewhere ${tag}`, q));
    const bobsWidget = await withTransaction((q) => addWidget(b, bobs.id, newWidget({ pinned: true }), q));
    assert.equal(bobsWidget.widgets[0].pinned, true);

    // 51st dashboard in the workspace.
    for (let i = await rowCount(a); i < MAX_DASHBOARDS; i += 1) {
      await withTransaction((q) => createDashboard(a, `d${i} ${tag}`, q));
    }
    assert.equal(await rowCount(a), MAX_DASHBOARDS);
    await refusal(
      withTransaction((q) => createDashboard(a, `one too many ${tag}`, q)),
      `workspace limit reached (${MAX_DASHBOARDS} dashboards)`,
    );
    assert.equal(await rowCount(a), MAX_DASHBOARDS, "a refused create still wrote a row");
    // The cap is the tenant's: bob is nowhere near it.
    assert.equal((await withTransaction((q) => createDashboard(b, `room ${tag}`, q))).name, `room ${tag}`);
  });
});

test("dropping a workspace takes its dashboards with it (D424's in-set foreign key)", { skip }, async () => {
  const tag = randomBytes(6).toString("hex");
  const doomed = `ws_t1c_${tag}`;
  await queryRows(`INSERT INTO workspaces (id, org_id) VALUES ($1, $2)`, [doomed, `org_t1c_${tag}`]);
  const board = await withTransaction((q) => createDashboard(doomed, "Latency", q));
  await withTransaction((q) => addWidget(doomed, board.id, newWidget(), q));
  assert.equal(await rowCount(doomed), 1);

  await queryRows(`DELETE FROM workspaces WHERE id = $1`, [doomed]);
  // No orphan rows to clean up later: a dashboard means nothing without its
  // workspace, which is why the FK is in-set and required.
  assert.equal(await rowCount(doomed), 0);
});
