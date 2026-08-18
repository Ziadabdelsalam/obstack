"use server";

import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import {
  deleteSavedView,
  listSavedViews,
  saveSavedView,
  type SavedView,
  type SavedViewFilters,
  type SavedViewSurface,
} from "@/server/saved-views";
import { getSessionContext } from "@/server/session";

/**
 * The three calls `SavedViewsMenu` makes. A Server Function is reachable by a
 * direct POST and not only through the UI (Next's own warning, `node_modules/
 * next/dist/docs/01-app/01-getting-started/07-mutating-data.md`), so the
 * workspace is resolved from the session HERE, on every call: the client names a
 * surface and a view, never a workspace.
 *
 * `null` is the answer when there is no workspace to scope views to — mock mode,
 * which has none and must not touch Postgres at all (D114's byte invariance), or
 * a caller with no session. The menu says so rather than showing an empty list,
 * which would read as "this workspace has saved nothing yet".
 */
async function activeWorkspace(): Promise<string | null> {
  // The mode check comes first and short-circuits: mock mode must run with no
  // Postgres present, so nothing below may be reached in it (D114).
  if (dataMode !== "live") return null;
  const session = await getSessionContext();
  return session?.workspaceId ?? null;
}

export async function listViews(surface: SavedViewSurface): Promise<SavedView[] | null> {
  const workspaceId = await activeWorkspace();
  return workspaceId === null ? null : listSavedViews(workspaceId, surface, queryRows);
}

export async function saveView(
  surface: SavedViewSurface,
  name: string,
  filters: SavedViewFilters,
): Promise<SavedView[] | null> {
  const workspaceId = await activeWorkspace();
  return workspaceId === null ? null : saveSavedView(workspaceId, surface, name, filters, queryRows);
}

export async function deleteView(
  surface: SavedViewSurface,
  name: string,
): Promise<SavedView[] | null> {
  const workspaceId = await activeWorkspace();
  return workspaceId === null ? null : deleteSavedView(workspaceId, surface, name, queryRows);
}
