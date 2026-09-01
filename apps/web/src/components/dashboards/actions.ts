"use server";

import type { Dashboard, DashboardActionResult, NewDashboardWidget } from "@/lib/dashboard-types";
import { dataMode } from "@/server/data";
import * as store from "@/server/dashboards";
import { withTransaction, type TxQuery } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The calls the dashboards editor, the add-widget form and Explore's "save to
 * dashboard" make. A Server Function is reachable by a direct POST and not only
 * through the UI (Next's own warning, `node_modules/next/dist/docs/01-app/
 * 01-getting-started/07-mutating-data.md`), so the workspace is resolved from
 * the session HERE, on every call: the client names a dashboard and a widget,
 * never a workspace.
 *
 * MUTATIONS ONLY (D441). Reading dashboards is the PAGE's job — the live
 * branches of `dashboards/page.tsx`, `dashboards/[id]/page.tsx`, `app/page.tsx`
 * and `explore/page.tsx` call `server/dashboards.ts` directly on their own
 * request — so there is exactly one definition of what a surface shows, and no
 * read of this store is reachable as a POST endpoint at all.
 *
 * `null` is the answer when there is no workspace to act in — mock mode, which
 * has none and must not touch Postgres at all (D114's byte invariance), or a
 * caller with no session. The surface says so rather than silently doing
 * nothing, which would read as a mutation that worked.
 *
 * Every mutation runs inside `withTransaction` so the store's advisory lock
 * (D197/D199) actually holds across its read→write: the lock is
 * transaction-scoped and through the plain pool it would release inside its own
 * implicit transaction and serialize nothing. This is what makes "two tabs at
 * eleven widgets" one moment. Refusals arrive as `DashboardRefusal` and become
 * `{ refused }` — the sentence the surface prints verbatim (D430/D436); every
 * OTHER failure propagates, so a real outage is never dressed up as a refusal.
 *
 * Nothing here revalidates: the editor calls `router.refresh()` after a result,
 * so the fresh page read is one definition of what the surface shows and it is
 * the one on the page.
 */
async function activeWorkspace(): Promise<string | null> {
  // The mode check comes first and short-circuits: mock mode must run with no
  // Postgres present, so nothing below may be reached in it (D114).
  if (dataMode !== "live") return null;
  const session = await getSessionContext();
  return session?.workspaceId ?? null;
}

/** The one mutation shape: session → transaction → the fresh row, or the sentence. */
async function mutate(
  write: (workspaceId: string, query: TxQuery) => Promise<Dashboard>,
): Promise<DashboardActionResult> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  try {
    return { dashboard: await withTransaction((query) => write(workspaceId, query)) };
  } catch (failure) {
    if (failure instanceof store.DashboardRefusal) return { refused: failure.message };
    throw failure;
  }
}

export async function createDashboard(name: string): Promise<DashboardActionResult> {
  return mutate((workspaceId, query) => store.createDashboard(workspaceId, name, query));
}

export async function renameDashboard(id: string, name: string): Promise<DashboardActionResult> {
  return mutate((workspaceId, query) => store.renameDashboard(workspaceId, id, name, query));
}

/** The fresh LIST, not a row: the dashboard the caller named is gone. */
export async function deleteDashboard(id: string): Promise<Dashboard[] | null> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  return withTransaction((query) => store.deleteDashboard(workspaceId, id, query));
}

export async function addWidget(
  id: string,
  widget: NewDashboardWidget,
): Promise<DashboardActionResult> {
  return mutate((workspaceId, query) => store.addWidget(workspaceId, id, widget, query));
}

export async function removeWidget(id: string, widgetId: string): Promise<DashboardActionResult> {
  return mutate((workspaceId, query) => store.removeWidget(workspaceId, id, widgetId, query));
}

export async function moveWidget(
  id: string,
  widgetId: string,
  direction: "up" | "down",
): Promise<DashboardActionResult> {
  return mutate((workspaceId, query) => store.moveWidget(workspaceId, id, widgetId, direction, query));
}

export async function setWidgetPinned(
  id: string,
  widgetId: string,
  pinned: boolean,
): Promise<DashboardActionResult> {
  return mutate((workspaceId, query) => store.setWidgetPinned(workspaceId, id, widgetId, pinned, query));
}
