import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ChangesLive } from "@/components/changes/ChangesLive";
import { ChangesMock } from "@/components/changes/ChangesMock";
import { listChangeEvents } from "@/server/changes";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * Changes, live-wired (S7.2 T5, D502) in the alerts page's D431 shape: the
 * mock branch returns master's page body (`ChangesMock`, byte-pinned) before
 * any await, so mock mode pays nothing for a live-only read; the live branch
 * reads the signed-in workspace's own change events and hands the rows to a
 * server component. The reads are the page's (D441) — the component queries
 * nothing.
 */

/** The newest events the timeline shows. Pagination is pre-registered
 *  (packet D502), not built. */
const FEED_LIMIT = 100;

export default async function ChangesPage() {
  if (dataMode !== "live") return <ChangesMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const events = await listChangeEvents(session.workspaceId, FEED_LIMIT, queryRows);

  return <ChangesLive events={events} />;
}
