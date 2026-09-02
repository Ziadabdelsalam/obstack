import { redirect } from "next/navigation";
import { connection } from "next/server";
import { SlosLive } from "@/components/slos/SlosLive";
import { SlosMock } from "@/components/slos/SlosMock";
import { listNotificationChannels } from "@/server/alerts";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { listSlos } from "@/server/slos";
import { getUsage } from "@/server/usage";

/**
 * SLOs, live-wired (S7.3 T5, D514) in the alerts page's D431 shape: the mock
 * branch returns master's page body (`SlosMock`, byte-pinned) before any
 * await, so mock mode pays nothing for a live-only read; the live branch
 * reads the signed-in workspace's own objectives (measured by the ingest
 * binary's evaluator, D510), its channels (for the editor) and its plan row
 * (for the D507 retention clip note) and hands the rows to a server
 * component. The reads are the page's (D441) — the component queries nothing.
 *
 * The workspace comes from the session and from nowhere else (D113).
 */
export default async function SlosPage() {
  if (dataMode !== "live") return <SlosMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const [slos, channels, usage] = await Promise.all([
    listSlos(session.workspaceId, queryRows),
    listNotificationChannels(session.workspaceId, queryRows),
    getUsage(session.workspaceId, queryRows),
  ]);

  return <SlosLive slos={slos} channels={channels} retentionDays={usage.retentionDays} planName={usage.planName} />;
}
