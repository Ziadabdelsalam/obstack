"use server";

import type { IncidentRow } from "@/lib/incident-types";
import { dataMode } from "@/server/data";
import * as store from "@/server/incidents";
import { withTransaction, type TxQuery } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The calls the incidents surface makes (S7.4 T6, D543/D546) — the
 * `components/slos/actions.ts` shape exactly: a Server Function is reachable
 * by a direct POST and not only through the UI, so the workspace is resolved
 * from the session HERE, on every call — the client names an incident or an
 * alert event, never a workspace.
 *
 * MUTATIONS ONLY (S6.3-L2/D441). Reading incidents, the promotable events, the
 * stitched timeline and the plan is the PAGES' job — the live branches of
 * `incidents/page.tsx` and `incidents/[id]/page.tsx` call the stores directly
 * on their own request — so there is exactly one definition of what each
 * surface shows, and no read of this store is reachable as a POST endpoint.
 *
 * `null` is the answer when there is no workspace to act in — mock mode,
 * which has none and must not touch Postgres at all (D114), or a caller with
 * no session. Every mutation runs inside `withTransaction` so the store's
 * advisory lock actually holds across its read→write: the cap is counted
 * under it on BOTH insert paths (D529), and promotion's scoped SELECT runs
 * under it before anything is written (D544). Refusals arrive as
 * `store.IncidentRefusal` and become `{ refused }` — the sentence the surface
 * prints verbatim (D430/D436 idiom); every OTHER failure propagates.
 *
 * Nothing here revalidates: callers call `router.refresh()` after a result,
 * and the detail's delete additionally `router.push`es to the list (D543).
 */
async function activeWorkspace(): Promise<string | null> {
  if (dataMode !== "live") return null;
  const session = await getSessionContext();
  return session?.workspaceId ?? null;
}

export type IncidentActionResult = { incident: IncidentRow } | { refused: string } | null;

/** The one mutation shape: session → transaction → the fresh row, or the sentence. */
async function mutate(
  write: (workspaceId: string, query: TxQuery) => Promise<IncidentRow>,
): Promise<IncidentActionResult> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  try {
    return { incident: await withTransaction((query) => write(workspaceId, query)) };
  } catch (failure) {
    if (failure instanceof store.IncidentRefusal) return { refused: failure.message };
    throw failure;
  }
}

export async function createIncident(input: store.IncidentInput): Promise<IncidentActionResult> {
  return mutate((workspaceId, query) => store.createIncident(workspaceId, input, query));
}

export async function updateIncident(id: string, input: store.IncidentInput): Promise<IncidentActionResult> {
  return mutate((workspaceId, query) => store.updateIncident(workspaceId, id, input, query));
}

/** `endedAt === null` means the SERVER stamps the end (D527): the browser's
 *  clock never lands in that column, so a blank field is sent as null and
 *  never as the client's idea of now. */
export async function resolveIncident(id: string, endedAt: string | null): Promise<IncidentActionResult> {
  return mutate((workspaceId, query) => store.resolveIncident(workspaceId, id, endedAt, query));
}

export async function reopenIncident(id: string): Promise<IncidentActionResult> {
  return mutate((workspaceId, query) => store.reopenIncident(workspaceId, id, query));
}

/** Tenancy is proven INSIDE the store with a scoped SELECT, never by the FK
 *  (D544): another tenant's event id and an invented one both come back as the
 *  D440 sentence, and a second promotion of the same event answers with the
 *  ORIGINAL incident rather than a refusal (first write wins). */
export async function promoteAlertEvent(eventId: string): Promise<IncidentActionResult> {
  return mutate((workspaceId, query) => store.promoteAlertEvent(workspaceId, eventId, query));
}

/**
 * Nothing comes back (D543). The `deleteSlo` precedent returns the remaining
 * list because an SLO card re-renders in place; this surface's header is
 * DERIVED (`{ongoing} ongoing · {total} total`), which a bare row array could
 * not restate, so the caller refreshes the route and the list read recomputes
 * both numbers. Never refuses: an id this workspace does not hold matches no
 * row and is silent — the same answer a stale tab gets (D440 for a delete).
 */
export async function deleteIncident(id: string): Promise<null | undefined> {
  const workspaceId = await activeWorkspace();
  if (workspaceId === null) return null;
  await withTransaction((query) => store.deleteIncident(workspaceId, id, query));
  return undefined;
}
