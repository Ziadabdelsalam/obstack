import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AlertsLive } from "@/components/alerts/AlertsLive";
import { AlertsMock } from "@/components/alerts/AlertsMock";
import { listAlertEvents, listAlertRules, listNotificationChannels } from "@/server/alerts";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";

/**
 * Alerts, live-wired (S7.1 T6, the D367/D431 shape): a server component
 * branching on `dataMode`. The mock branch renders `AlertsMock` — the page
 * body as it always was, byte for byte — with zero props and before any
 * await, so the public demo's DOM does not move (D438/D114). The live branch
 * reads `server/alerts.ts` directly on its own request (D441: reads are the
 * page's; `components/alerts/actions.ts` is mutations only) and hands
 * `AlertsLive` nothing but resolved rows.
 *
 * The workspace comes from the session and from nowhere else (D113): rules,
 * events and channels are visible to every member of their workspace and to
 * nobody else.
 */
const EVENT_FEED_LIMIT = 50;

export default async function AlertsPage() {
  if (dataMode !== "live") return <AlertsMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const [rules, events, channels] = await Promise.all([
    listAlertRules(session.workspaceId, queryRows),
    listAlertEvents(session.workspaceId, EVENT_FEED_LIMIT, queryRows),
    listNotificationChannels(session.workspaceId, queryRows),
  ]);

  return <AlertsLive rules={rules} events={events} channels={channels} />;
}
