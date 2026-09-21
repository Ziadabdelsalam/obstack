import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { getAuth } from "@/server/auth";
import { queryRows, type QueryRows } from "@/server/postgres";

/** Who is asking, and which workspace their request reads (D114). */
export type SessionContext = { userId: string; orgId: string; workspaceId: string };

/**
 * Which workspace a request reads (D717, superseding D114's "no switcher"):
 * the one the person CHOSE, if they chose one and are still a member of the
 * organization that owns it; otherwise the org they OWN — the one signup made
 * them owner of — and that org's first workspace. One statement answers both,
 * and the ORDER BY is the whole rule: a row the choice matches sorts first, an
 * owner row sorts before a member row, and `created_at, id` breaks the tie the
 * way it always has. `LIMIT 1` is what makes "active" one answer.
 *
 * The choice is a PREFERENCE, never an authority. `active_workspaces`
 * (0015) is LEFT JOINed on the user AND the workspace of a membership row, so
 * a choice pointing at an organization the person has left matches nothing
 * and the owner default answers — the switcher's write checks membership too
 * (`server/workspaces.ts`), but the read does not trust the write.
 *
 * The `role = 'owner'` pin keeps its D120 job as the DEFAULT: membership is
 * still not identity, so accepting an invitation (S3.2) moves nobody — a
 * `member` row sorts below an owner row until the person switches, and
 * better-auth's `session.activeOrganizationId`, which acceptance writes to the
 * inviting org, is still read by nothing here (D143). Both are proven against
 * real rows in `auth.integration.test.ts` and `invites.integration.test.ts`.
 *
 * The join also answers "which org" — a member row is the only place a user's
 * org is recorded, and reading it here means the session cookie is never
 * trusted for tenancy.
 */
const ACTIVE_WORKSPACE_SQL = `
  SELECT m."organizationId" AS org_id, w.id AS workspace_id
    FROM "member" m
    JOIN workspaces w ON w.org_id = m."organizationId"
    LEFT JOIN active_workspaces a ON a.user_id = m."userId" AND a.workspace_id = w.id
   WHERE m."userId" = $1
   ORDER BY (a.workspace_id IS NOT NULL) DESC, (m.role = 'owner') DESC, w.created_at, w.id
   LIMIT 1`;

/**
 * The resolution half of `getSessionContext`, with the read path passed in
 * rather than imported (D113's rule for the scoped ClickHouse client, applied
 * to this store): it is the half a test can drive without a server.
 *
 * A signed-in user with no workspace is the half-state D117's signup contract
 * forbids, so it throws rather than returning null — null here means "no
 * session", and answering it for a user who HAS one would send them back to
 * /login in a loop instead of surfacing the broken row.
 */
export async function resolveSessionContext(
  userId: string,
  query: QueryRows,
): Promise<SessionContext> {
  const [row] = await query<{ org_id: string; workspace_id: string }>(ACTIVE_WORKSPACE_SQL, [
    userId,
  ]);
  if (!row) {
    throw new Error(`signed-in user ${userId} has no workspace — signup left a half-state`);
  }
  return { userId, orgId: row.org_id, workspaceId: row.workspace_id };
}

/**
 * Pure resolution, no redirect (D114): callers decide what a missing session
 * means. The live-mode guard is the app layout's, and nothing here reads the
 * data mode — a caller that reaches this module has already decided it is live.
 *
 * Memoized per REQUEST, not per process (D134): every reader in one render —
 * the shell, the page's `dataForSession`, and whatever S3.2 adds — asks the
 * same question, and before this each one paid for its own answer (measured: 2
 * workspace reads and 3 better-auth session reads per signed-in `/app` render).
 * Two things are wrong with that beyond the cost. The reader count grows with
 * every surface, so the amplification is a class, not a number. And N
 * independent resolutions of the same request can disagree — a session that
 * expires between the layout's read and the page's would render a shell for one
 * tenant around a page that resolved to nothing.
 *
 * React's `cache` is the right scope precisely because it is not a cache in the
 * usual sense: its memo lives on the render's cache root, which Next creates per
 * request, so nothing survives to a second request. That is a TENANCY property
 * here, not a performance one — a resolution shared across requests would hand
 * one stranger another stranger's workspace, so the isolation is proven both
 * ways rather than assumed (F7's report).
 *
 * Outside a render pass — a server action, a route handler, a test — React's
 * `cache` has no dispatcher and calls straight through (verified in the
 * installed react build: `if (!dispatcher) return fn.apply(null, arguments)`).
 * So this is memoization where a render can use it and a plain call everywhere
 * else; the signature and the semantics are the ones D114(f) fixed.
 */
export const getSessionContext = cache(async (): Promise<SessionContext | null> => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  return resolveSessionContext(session.user.id, queryRows);
});
