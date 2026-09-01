import { redirect } from "next/navigation";
import { connection } from "next/server";
import { UsersLive } from "@/components/users/UsersLive";
import { UsersMock } from "@/components/users/UsersMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { listImpactedUsers } from "@/server/queries/users";
import { getSessionContext } from "@/server/session";

/**
 * Users, live-wired (D367/D392): a server component branching on `dataMode`
 * (the `connections/page.tsx:36` idiom), never the `data.ts` facade — the
 * mock branch renders `UsersMock` verbatim, with zero props, before any
 * live-only read runs; the live branch reads D398's frozen contract directly
 * through `forWorkspace` and feeds `UsersLive` nothing but resolved,
 * server-fetched props.
 */
export default async function UsersPage() {
  if (dataMode !== "live") return <UsersMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const ch = forWorkspace(session.workspaceId);
  const { users, totalUsers } = await listImpactedUsers(ch);

  return <UsersLive users={users} totalUsers={totalUsers} />;
}
