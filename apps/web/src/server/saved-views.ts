import "server-only";
import { randomBytes } from "node:crypto";
import { PAGE_PARAM } from "@/lib/traces-filter";
import type { QueryRows } from "@/server/postgres";

/**
 * Saved views: workspace-scoped rows in the product store (D30/D97/D116).
 *
 * This is the ONE module that owns saved-view persistence. The browser store it
 * replaces — `lib/saved-views.ts` and the `obstack.saved-views` key — is deleted
 * outright, with nothing read back out of it (D52: discard, never read). A view
 * now belongs to a workspace, so everyone signed into that workspace sees the
 * same list and no view is stranded in one operator's browser.
 *
 * D47's identity contract carries over unchanged: the trimmed name is the
 * identity within a surface, saving over a name replaces that view (here, an
 * UPSERT on the table's unique key rather than a second row nobody can tell
 * apart), and `filters` is the surface's URL shape — one string per key — minus
 * the page key, because a view is a question and not a position in a result set.
 *
 * The workspace is a PARAMETER and never ambient: the read path is passed in the
 * way `resolveSessionContext` takes it (D113's rule applied to this store), and
 * the workspace id comes from the session on the server (`components/saved-views/
 * actions.ts`) — never from the client, which only ever names a surface.
 */

/** The surfaces that keep views — `saved_views.surface`'s CHECK, stated once. */
export const SAVED_VIEW_SURFACES = ["traces", "logs"] as const;

export type SavedViewSurface = (typeof SAVED_VIEW_SURFACES)[number];

/**
 * A view's filters are its surface's URL parameters, exactly the shape the URL
 * serializes (`Object.fromEntries(searchParams)`), so applying a view is setting
 * the URL: one state, not two. A view holds the surface's WHOLE filter set, time
 * range included, so applying one REPLACES the surface's filter state rather
 * than patching it — a key the view does not carry is a filter it does not set.
 */
export type SavedViewFilters = Record<string, string>;

/** Name is the identity within a surface: saving over a name replaces that view. */
export interface SavedView {
  name: string;
  filters: SavedViewFilters;
}

/**
 * Every statement binds the workspace as `$1` and names `workspace_id` in its
 * text. That is not a style: `saved-views.test.ts` asserts both for every call
 * this module makes, so a predicate dropped here — or a workspace threaded past
 * one statement but not another — goes red instead of leaking a view sideways.
 */
const LIST_SQL = `
  SELECT name, filters
    FROM saved_views
   WHERE workspace_id = $1 AND surface = $2
   ORDER BY created_at, name`;

/**
 * Save-over-name is the unique key's UPSERT (D116). `created_at` is deliberately
 * untouched on the update, so a replaced view keeps the place it holds in the
 * menu instead of jumping to the end — the browser store's behaviour, preserved.
 *
 * `workspace_id` leads the column list so it can lead the bindings; see above.
 */
const UPSERT_SQL = `
  INSERT INTO saved_views (workspace_id, surface, name, filters, id)
       VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (workspace_id, surface, name)
    DO UPDATE SET filters = EXCLUDED.filters, updated_at = now()`;

const DELETE_SQL = `
  DELETE FROM saved_views
   WHERE workspace_id = $1 AND surface = $2 AND name = $3`;

const newId = (): string => `view_${randomBytes(8).toString("hex")}`;

/**
 * The surface reaches this module from a server action, so it is client input:
 * a name outside the CHECK's vocabulary is refused here rather than sent to
 * Postgres to be refused there (a read would not be refused at all — it would
 * quietly answer with nothing).
 */
function checkedSurface(surface: SavedViewSurface): SavedViewSurface {
  if (!SAVED_VIEW_SURFACES.includes(surface)) {
    throw new Error(`unknown saved-view surface ${JSON.stringify(surface)}`);
  }
  return surface;
}

/**
 * What actually gets stored: the URL shape, minus the page key. The strip is by
 * `PAGE_PARAM`, imported from the one surface that paginates rather than
 * restated — a second literal here would drift from the traces bar's parameter
 * name and persist the page into the view (D47(ii)/D53).
 *
 * Non-string values cannot come from either bar; they can come from a direct
 * POST at the action, and a view carrying them would not read back as the shape
 * this module's type promises. They are dropped rather than thrown on, the same
 * total-parse posture the URL contracts keep (D68) — and so is a payload that is
 * not a filter object at all, which reads as a view that carries no filters
 * rather than as a crash (`null`) or as an object of string indices (`"abc"`).
 */
function storedFilters(filters: SavedViewFilters): SavedViewFilters {
  if (typeof filters !== "object" || filters === null || Array.isArray(filters)) return {};
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([key, value]) => key !== PAGE_PARAM && typeof value === "string",
    ),
  );
}

/** The workspace's views on one surface, oldest first. */
export async function listSavedViews(
  workspaceId: string,
  surface: SavedViewSurface,
  query: QueryRows,
): Promise<SavedView[]> {
  const rows = await query<{ name: string; filters: SavedViewFilters }>(LIST_SQL, [
    workspaceId,
    checkedSurface(surface),
  ]);
  return rows.map((row) => ({ name: row.name, filters: row.filters }));
}

/**
 * Create `name` on `surface` in this workspace, or replace the view already
 * holding that name. A blank name is not a name and writes nothing.
 *
 * Returns the workspace's persisted views — read back rather than assembled
 * locally, so a menu shows what the store holds and never what the caller hoped.
 */
export async function saveSavedView(
  workspaceId: string,
  surface: SavedViewSurface,
  name: string,
  filters: SavedViewFilters,
  query: QueryRows,
): Promise<SavedView[]> {
  const trimmed = name.trim();
  if (trimmed) {
    await query(UPSERT_SQL, [
      workspaceId,
      checkedSurface(surface),
      trimmed,
      JSON.stringify(storedFilters(filters)),
      newId(),
    ]);
  }
  return listSavedViews(workspaceId, surface, query);
}

/** Drop `name` from `surface` in this workspace. Returns the persisted views. */
export async function deleteSavedView(
  workspaceId: string,
  surface: SavedViewSurface,
  name: string,
  query: QueryRows,
): Promise<SavedView[]> {
  await query(DELETE_SQL, [workspaceId, checkedSurface(surface), name]);
  return listSavedViews(workspaceId, surface, query);
}
