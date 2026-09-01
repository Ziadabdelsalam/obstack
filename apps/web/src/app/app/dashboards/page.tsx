import { redirect } from "next/navigation";
import { connection } from "next/server";
import { DashboardsLive } from "@/components/dashboards/DashboardsLive";
import { DashboardsMock } from "@/components/dashboards/DashboardsMock";
import { dataMode } from "@/server/data";
import { listDashboards } from "@/server/dashboards";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * The dashboards list, live-wired (D367/D431): a server component branching on
 * `dataMode` (the `services/page.tsx:22` idiom), never the `data.ts` facade —
 * the live branch reads `server/dashboards.ts` directly (D441: reads are the
 * page's, the actions file is mutations only) and hands `DashboardsLive`
 * nothing but resolved props. The mock branch renders `DashboardsMock`
 * verbatim, with zero props and before any await, so the rendered DOM there is
 * unchanged (D438).
 *
 * The workspace comes from the session and from nowhere else (D113): a
 * dashboard is visible to every member of its workspace and to nobody else,
 * which is the whole of this sprint's ACL.
 */
export default async function DashboardsPage() {
  if (dataMode !== "live") return <DashboardsMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  return <DashboardsLive dashboards={await listDashboards(session.workspaceId, queryRows)} />;
}
