import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";
import { PAGE_PARAM } from "@/lib/traces-filter";
import {
  deleteSavedView,
  listSavedViews,
  saveSavedView,
  type SavedViewFilters,
  type SavedViewSurface,
} from "./saved-views";
import type { QueryRows } from "./postgres";

// run with: npm test --workspace apps/web
//
// The saved-views store's contract: every statement is bound to the workspace
// it was handed, and D47's identity rules survive the move out of the browser
// (D30/D97/D116). The read path is a parameter (D113's rule applied to this
// store), so this file needs neither a request nor a server — deliberately: it
// must pass on a machine with no Postgres at all, and `web`'s skip trap allows
// no skips.
//
// The rows-actually-disjoint half was MEASURED against a real postgres:17.11 at
// execution (T6's report): container `docker run --rm -d -p 127.0.0.1:55433:5432
// -e POSTGRES_USER=obstack -e POSTGRES_PASSWORD=obstack_postgres_dev
// -e POSTGRES_DB=obstack postgres:17.11`, schema applied from
// services/ingest/pgmigrations/0001..0003, two workspaces `ws_a`/`ws_b` — a view
// saved in one is invisible to the other, the same name in each is two rows, and
// saving over a name in one leaves the other's row untouched.

type Statement = { sql: string; params?: unknown[] };

function recordingQuery(rows: unknown[] = []) {
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

/** The filter set a bar hands the menu, page included — the store does the strip. */
const onPageThree = { status: "error", range: "24h", [PAGE_PARAM]: "3" };

test("every statement is bound to the workspace it was handed", async () => {
  const { query, seen } = recordingQuery();

  await listSavedViews("ws_a", "traces", query);
  await saveSavedView("ws_a", "traces", "escalations", onPageThree, query);
  await deleteSavedView("ws_a", "traces", "escalations", query);

  assert.ok(seen.length >= 5, `only ${seen.length} statements ran — this loop would pass vacuously`);
  for (const { sql, params } of seen) {
    // Both halves, because either alone is passable: SQL that names the column
    // but binds someone else's id, or a first binding no predicate reads.
    assert.match(sql, /workspace_id/, `a statement does not scope by workspace: ${sql}`);
    assert.equal(params?.[0], "ws_a", `a statement bound ${String(params?.[0])} as its workspace`);
  }
});

test("the workspace is a binding, never something the caller filters afterwards", async () => {
  const { query, seen } = recordingQuery();
  await listSavedViews("ws_b", "logs", query);

  assert.match(seen[0].sql, /WHERE workspace_id = \$1 AND surface = \$2/);
  assert.deepEqual(seen[0].params, ["ws_b", "logs"]);
  // Oldest first, as the browser store listed them; the name breaks the tie so
  // two views written in one transaction cannot swap places between reads.
  assert.match(seen[0].sql, /ORDER BY created_at, name/);
});

test("saving over a name replaces that view rather than adding a second (D47/D116)", async () => {
  const { query, seen } = recordingQuery();
  await saveSavedView("ws_a", "traces", "escalations", { status: "error" }, query);

  const upsert = seen[0].sql;
  assert.match(upsert, /ON CONFLICT \(workspace_id, surface, name\)/);
  assert.match(upsert, /DO UPDATE SET filters = EXCLUDED\.filters/);
  // `created_at` is untouched on the update, so a replaced view keeps its place
  // in the menu — the ORDER BY above is what reads it.
  assert.equal(/DO UPDATE SET[^]*created_at/.test(upsert), false, upsert);
});

test("a view carries the whole filter set, the time range included, but never the page", async () => {
  const { query, seen } = recordingQuery();
  await saveSavedView("ws_a", "traces", "  escalations  ", onPageThree, query);

  const [, , name, filters] = seen[0].params as string[];
  // The name is trimmed before it becomes the identity, exactly as the browser
  // store trimmed it (D47).
  assert.equal(name, "escalations");
  assert.deepEqual(JSON.parse(filters), { status: "error", range: "24h" });
  // The strip is by the traces surface's own PAGE_PARAM, so a page parameter
  // renamed there is renamed here too rather than silently persisted (D53).
  assert.equal(PAGE_PARAM in JSON.parse(filters), false);
});

test("a blank name is not a name and writes nothing", async () => {
  const { query, seen } = recordingQuery();
  const views = await saveSavedView("ws_a", "traces", "   ", { status: "error" }, query);

  assert.deepEqual(views, []);
  assert.equal(seen.length, 1, "a blank name still cost a write");
  assert.match(seen[0].sql, /SELECT name, filters/);
});

test("a surface outside the CHECK's vocabulary is refused before Postgres sees it", async () => {
  const { query, seen } = recordingQuery();
  // The surface is the one thing the client names on a server action, and a
  // READ with an unknown surface would not be refused by the CHECK at all — it
  // would quietly answer with nothing, which reads as an empty workspace.
  const bogus = "traces', 'logs" as SavedViewSurface;

  await assert.rejects(listSavedViews("ws_a", bogus, query), /unknown saved-view surface/);
  await assert.rejects(saveSavedView("ws_a", bogus, "x", {}, query), /unknown saved-view surface/);
  await assert.rejects(deleteSavedView("ws_a", bogus, "x", query), /unknown saved-view surface/);
  assert.deepEqual(seen, [], "an unknown surface reached the database");
});

test("a filter value that is not a string never reaches the store", async () => {
  const { query, seen } = recordingQuery();
  // Neither bar can produce this; a direct POST at the server action can, and a
  // row holding it would not read back as the shape this module's type promises.
  const hostile = { status: "error", nested: { a: "b" }, count: 3 } as unknown as Record<
    string,
    string
  >;
  await saveSavedView("ws_a", "logs", "odd", hostile, query);

  assert.deepEqual(JSON.parse((seen[0].params as string[])[3]), { status: "error" });
});

test("a filters payload that is not a filter object is a view with no filters", async () => {
  // Measured at review against the running server action: `null` used to throw
  // out of the store and a string used to be spread into `{"0":"a",…}` and
  // persisted. Same class as the value drop above, so the same total-parse
  // answer — a view that carries nothing rather than a crash or a junk row.
  for (const payload of [null, undefined, "abc", 7, ["a", "b"]]) {
    const { query, seen } = recordingQuery();
    await saveSavedView("ws_a", "logs", "odd", payload as unknown as SavedViewFilters, query);
    assert.deepEqual(JSON.parse((seen[0].params as string[])[3]), {}, `payload ${JSON.stringify(payload)}`);
  }
});

test("each saved view gets its own app-generated id (D116)", async () => {
  const { query, seen } = recordingQuery();
  await saveSavedView("ws_a", "traces", "one", {}, query);
  await saveSavedView("ws_a", "traces", "two", {}, query);

  const ids = [seen[0], seen[2]].map((s) => (s.params as string[])[4]);
  assert.match(ids[0], /^view_[0-9a-f]{16}$/);
  assert.notEqual(ids[0], ids[1]);
});

test("a delete names the workspace, the surface and the view — and nothing else", async () => {
  const { query, seen } = recordingQuery();
  await deleteSavedView("ws_a", "logs", "escalations", query);

  assert.match(seen[0].sql, /DELETE FROM saved_views/);
  assert.match(seen[0].sql, /WHERE workspace_id = \$1 AND surface = \$2 AND name = \$3/);
  assert.deepEqual(seen[0].params, ["ws_a", "logs", "escalations"]);
});

test("a mutation answers with what the store holds, not with what the caller asked for", async () => {
  // The store is read back after every write, so a menu can never offer a view
  // the database refused — the browser store's rule, kept (D47(v)).
  const persisted = [{ name: "Errors only", filters: { status: "error" } }];
  const { query, seen } = recordingQuery(persisted);

  assert.deepEqual(await saveSavedView("ws_a", "traces", "Slow", { minMs: "5000" }, query), persisted);
  assert.deepEqual(await deleteSavedView("ws_a", "traces", "Errors only", query), persisted);
  assert.equal(
    seen.filter((s) => s.sql.includes("SELECT name, filters")).length,
    2,
    "a mutation answered without reading the store back",
  );
});
