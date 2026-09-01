import { redirect } from "next/navigation";
import { connection } from "next/server";
import { IssuesLive } from "@/components/issues/IssuesLive";
import { IssuesMock } from "@/components/issues/IssuesMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { listIssues } from "@/server/queries/issues";
import { getSessionContext } from "@/server/session";

/**
 * Issues, live-wired (D367): a server component branching on `dataMode` (the
 * `connections/page.tsx:36` idiom), never the `data.ts` facade — the live
 * branch reads `listIssues` directly and hands `IssuesLive` nothing but
 * resolved, server-fetched props. The mock branch renders `IssuesMock`
 * verbatim, with zero props, so the rendered DOM there is unchanged.
 *
 * There is no query string to read: D394 fixes the window at 24h, and D361
 * leaves nothing to select, assign or filter by. One read, one workspace.
 */
export default async function IssuesPage() {
  if (dataMode !== "live") return <IssuesMock />;
  await connection();

  const session = await getSessionContext();
  // The layout redirects too, but a layout does not control whether the segment
  // below it renders: this page resolves its own session rather than reading a
  // workspace off a null.
  if (!session) redirect("/login");

  const { issues, total } = await listIssues(forWorkspace(session.workspaceId));
  return <IssuesLive issues={issues} total={total} />;
}
