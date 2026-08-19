import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { SettingsSuite, type LiveSettings } from "@/components/settings/SettingsSuite";
import { listApiKeys } from "@/server/api-keys";
import { dataMode } from "@/server/data";
import { getOrgName, inviteLinkPath, listOrgMembers, listPendingInvites } from "@/server/invites";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { settingsErrorMessage } from "./errors";

/**
 * The reads of the settings surface; the writes are `actions.ts`.
 *
 * Mock mode returns FIRST, before `connection()` and before `searchParams` is
 * awaited, and that ordering is the whole of D125 here: the demo product has no
 * accounts and no Postgres, so this page must reach for neither — and a page
 * that awaited a request-time API above the mode check would also stop being
 * prerenderable in a mock build, which is a behaviour change to every visitor of
 * the demo for the sake of a branch they never take.
 *
 * Live mode is per-request by construction — whose org, whose keys — so it holds
 * for a real request (D27a) and reads through the session context. Everything
 * below is scoped by `session.orgId`/`session.workspaceId` and nothing on this
 * page takes a tenant from the URL (D148).
 */

/**
 * UTC, and formatted here rather than in the client component: a date formatted
 * on both sides of hydration is formatted in two timezones. Minute precision on
 * an expiry because better-auth's invitations last 48 hours (measured) — a
 * day-only rendering of "expires" would round a link's death by half a day.
 */
const asDay = (at: Date): string => at.toISOString().slice(0, 10);
const asMinute = (at: Date): string => `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  if (dataMode !== "live") return <SettingsSuite live={null} />;
  await connection();

  const session = await getSessionContext();
  // The layout redirects too, but a layout does not control whether the segment
  // below it renders (its own note): this page resolves its own session, so it
  // answers for itself rather than reading a workspace off a null.
  if (!session) redirect("/login");

  const requestHeaders = await headers();
  const [orgName, members, invites, keys] = await Promise.all([
    getOrgName(session.orgId, queryRows),
    listOrgMembers(session.orgId, queryRows),
    listPendingInvites(session.orgId, requestHeaders),
    listApiKeys(session.workspaceId, queryRows),
  ]);

  // A member row pointing at an organization that does not exist is the same
  // class of half-state `resolveSessionContext` refuses to paper over: loud
  // here beats a settings page that names the workspace after nobody.
  if (!orgName) throw new Error(`organization ${session.orgId} has no row`);

  const live: LiveSettings = {
    orgName,
    workspaceId: session.workspaceId,
    members,
    invites: invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      linkPath: inviteLinkPath(invite.id),
      expires: asMinute(invite.expiresAt),
    })),
    keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      created: asDay(key.createdAt),
      revoked: key.revokedAt ? asDay(key.revokedAt) : null,
    })),
    // The code from the URL is mapped to fixed copy and never rendered (D121).
    errorMessage: settingsErrorMessage((await searchParams).error),
  };

  return <SettingsSuite live={live} />;
}
