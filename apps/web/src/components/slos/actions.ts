"use server";

import type { SloRow } from "@/lib/slo-types";
import { dataMode } from "@/server/data";
import * as store from "@/server/slos";
import { withTransaction, type TxQuery } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The calls the SLO cards and the editor make (S7.3 T5) — the
 * `components/alerts/actions.ts` shape exactly: a Server Function is
 * reachable by a direct POST and not only through the UI, so the workspace is
 * resolved from the session HERE, on every call — the client names an SLO or
 * a channel, never a workspace.
 *
 * MUTATIONS ONLY (S6.3-L2/D441). Reading SLOs, channels and the plan is the
 * PAGE's job — the live branch of `slos/page.tsx` calls the stores directly
 * on its own request — so there is exactly one definition of what the
 * surface shows, and no read of this store is reachable as a POST endpoint.
 *
 * `null` is the answer when there is no workspace to act in — mock mode,
 * which has none and must not touch Postgres at all (D114), or a caller with
 * no session. Every mutation runs inside `withTransaction` so the store's
 * advisory lock actually holds across its read→write. Refusals arrive as
 * `store.SloRefusal` and become `{ refused }` — the sentence the surface
 * prints verbatim (D430/D436 idiom); every OTHER failure propagates.
 *
 * Nothing here revalidates: callers call `router.refresh()` after a result.
 */
async function activeWorkspace(): Promise<string | null> {
  if (dataMode !== "live") return null;
  const session = await getSessionContext();
  return session?.workspaceId ?? null;
}

export type SloActionResult = { slo: SloRow } | { refused: string } | null;

/** The one mutation shape: session → transaction → the fresh row, or the sentence. */
async function mutate(write: (workspaceId: string, query: TxQuery) => Promise<SloRow>): Promise<SloActionResult> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  try {
    return { slo: await withTransaction((query) => write(workspaceId, query)) };
  } catch (failure) {
    if (failure instanceof store.SloRefusal) return { refused: failure.message };
    throw failure;
  }
}

export async function createSlo(input: store.SloInput): Promise<SloActionResult> {
  return mutate((workspaceId, query) => store.createSlo(workspaceId, input, query));
}

export async function updateSlo(id: string, input: store.SloInput): Promise<SloActionResult> {
  return mutate((workspaceId, query) => store.updateSlo(workspaceId, id, input, query));
}

export async function setSloEnabled(id: string, enabled: boolean): Promise<SloActionResult> {
  return mutate((workspaceId, query) => store.setSloEnabled(workspaceId, id, enabled, query));
}

/** The fresh LIST, not a row: the SLO the caller named is gone. Never
 *  refuses — an id this workspace does not hold matches no row and the
 *  answer is the workspace's own list unchanged; its events CASCADE. */
export async function deleteSlo(id: string): Promise<SloRow[] | null> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  return withTransaction((query) => store.deleteSlo(workspaceId, id, query));
}
