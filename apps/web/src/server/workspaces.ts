import "server-only";
import type { QueryRows } from "@/server/postgres";

/**
 * The workspace switcher's store (D717): which workspaces a person may read,
 * and the one they chose. Both halves are `$1`-bound statements over the
 * membership rows this repo already reads (`invites.ts`'s roster join,
 * `account.ts`'s memberships) plus the one table this feature adds
 * (`active_workspaces`, 0015). Nothing here takes a tenant from a caller: the
 * user id is the session's, and the workspace id a caller names is judged by
 * the membership join inside the write itself.
 *
 * What a choice does is decided in `session.ts`, not here: the resolution
 * sorts a chosen row first while the person is still a member of its
 * organization, and falls back to the owner's first workspace otherwise. This
 * module only records the choice — and refuses to record one the person is
 * not entitled to.
 */

/** One workspace a person may switch to, with the organization it belongs to and their role there. */
export interface WorkspaceChoice {
  workspaceId: string;
  orgId: string;
  orgName: string;
  role: string;
}

/**
 * Every workspace of every organization the person belongs to: the owned
 * organization first (it is the default the resolution falls back to), then
 * the others in the order the memberships were made. An organization with more
 * than one workspace lists each of them (org→workspaces is 1:N, D95).
 */
const CHOICES_SQL = `
  SELECT w.id AS workspace_id, o.id AS org_id, o.name AS org_name, m.role
    FROM "member" m
    JOIN "organization" o ON o.id = m."organizationId"
    JOIN workspaces w ON w.org_id = o.id
   WHERE m."userId" = $1
   ORDER BY (m.role = 'owner') DESC, m."createdAt", m.id, w.created_at, w.id`;

export async function listWorkspaceChoices(userId: string, query: QueryRows): Promise<WorkspaceChoice[]> {
  const rows = await query<{ workspace_id: string; org_id: string; org_name: string; role: string }>(
    CHOICES_SQL,
    [userId],
  );
  return rows.map((row) => ({
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    orgName: row.org_name,
    role: row.role,
  }));
}

/**
 * A workspace id, as a total parse (D68). Signup writes `ws_` + 16 hex
 * characters (`auth.ts`'s `id()`), the 0004 continuity seed writes `ws_demo`,
 * and the integration suites write ids of their own — so the alphabet is the
 * one every spelling in the repo uses, bounded, and nothing outside it reaches
 * a bound parameter. An id is only ever bound as `$2` or compared.
 */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseWorkspaceId(raw: FormDataEntryValue | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  return WORKSPACE_ID.test(raw) ? raw : null;
}

/**
 * A switch that named a workspace the person is not a member of — or one that
 * does not exist. One class for both, because from the person's side they are
 * one situation: a list that went stale, or a post from somewhere the sidebar
 * never offers.
 */
export class UnknownWorkspace extends Error {
  constructor(workspaceId: string) {
    super(`no workspace ${JSON.stringify(workspaceId)} among this account's organizations`);
    this.name = "UnknownWorkspace";
  }
}

/**
 * Record the choice. The membership check IS the INSERT's source row: the
 * statement selects the (user, workspace) pair out of a join of `workspaces`
 * to the caller's own `member` rows, so a workspace whose organization the
 * caller does not belong to yields no row, writes nothing, and comes back as
 * `UnknownWorkspace`. `ON CONFLICT` makes a second choice replace the first —
 * one row per person, which is what "the active workspace" means.
 */
const SET_ACTIVE_SQL = `
  INSERT INTO active_workspaces (user_id, workspace_id, updated_at)
  SELECT m."userId", w.id, now()
    FROM workspaces w
    JOIN "member" m ON m."organizationId" = w.org_id AND m."userId" = $1
   WHERE w.id = $2
  ON CONFLICT (user_id) DO UPDATE
      SET workspace_id = EXCLUDED.workspace_id, updated_at = EXCLUDED.updated_at
  RETURNING workspace_id`;

export async function setActiveWorkspace(
  userId: string,
  workspaceId: string,
  query: QueryRows,
): Promise<void> {
  const rows = await query<{ workspace_id: string }>(SET_ACTIVE_SQL, [userId, workspaceId]);
  if (rows.length === 0) throw new UnknownWorkspace(workspaceId);
}
