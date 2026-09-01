import { redirect } from "next/navigation";
import { connection } from "next/server";
import { DashboardDetailLive } from "@/components/dashboards/DashboardDetailLive";
import { DashboardDetailMock } from "@/components/dashboards/DashboardDetailMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { getDashboard } from "@/server/dashboards";
import { queryRows } from "@/server/postgres";
import { getSessionContext } from "@/server/session";
import { listMetricCatalog } from "@/server/queries/metrics";
import { loadWidgetResults } from "@/server/widget-results";

/**
 * One dashboard, live-wired (D367/D431), same shape as the list beside it. The
 * mock branch hands `DashboardDetailMock` the `params` PROMISE rather than
 * awaiting it here (`services/[id]/page.tsx:33`): the moved body awaits it
 * exactly as it always did, which is what keeps the mock branch ahead of every
 * await on this page and its DOM unchanged (D438).
 *
 * The page does ALL the reading (D428) — the row from Postgres, the metric
 * catalog the add-widget form offers, and one metrics read per widget — and
 * `DashboardDetailLive` renders resolved props with no fetching of its own.
 * An id this workspace does not hold arrives as `null` and is a sentence, not
 * a 500 and never another tenant's row (D436).
 */
export default async function DashboardDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (dataMode !== "live") return <DashboardDetailMock params={params} />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const { id } = await params;
  const ch = forWorkspace(session.workspaceId);
  // The row and the catalog are independent; the widget reads are not — they
  // need the row's widget array — so the chain joins the same `Promise.all`
  // instead of waiting for the catalog first (D428).
  const row = getDashboard(session.workspaceId, id, queryRows);
  const [dashboard, catalog, loads] = await Promise.all([
    row,
    listMetricCatalog(ch),
    row.then((d) => loadWidgetResults(ch, d?.widgets ?? [])),
  ]);

  return <DashboardDetailLive dashboard={dashboard} catalog={catalog} loads={loads} />;
}
