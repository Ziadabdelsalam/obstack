import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ServiceDetailLive } from "@/components/services/ServiceDetailLive";
import { ServiceDetailMock } from "@/components/services/ServiceDetailMock";
import { listServiceDeploys } from "@/server/changes";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { queryRows } from "@/server/postgres";
import { getService } from "@/server/queries/services";
import { getSessionContext } from "@/server/session";

/**
 * One service, live-wired (D367), same shape as the catalog above it. The mock
 * branch hands `ServiceDetailMock` the `params` PROMISE rather than awaiting
 * it here: the moved body awaits it exactly as it always did, which is what
 * keeps the mock branch ahead of every await on this page and its DOM
 * unchanged.
 *
 * D503 (the D362 release, S7.2): this file names NO mock module any more. The
 * deploys panel was the one fenced section of the live page — it rendered the
 * `@/mock/intelligence` fixture under a SampleMark until the changes feed
 * landed — and it now reads this service's own `deploy` events from
 * `change_events`, through `server/changes.ts`, beside the ClickHouse read of
 * the scorecard. `ServiceDetailMock` keeps its own fixture import, untouched.
 *
 * The `[id]` segment carries the SERVICE NAME in live mode (`spans.service` is
 * the identity — there is no separate id to look up); Next decodes it. The
 * deploys read matches that name by equality (D499): a deploy recorded under
 * another spelling is on the changes timeline, not on this page.
 */

/** The panel's depth, the fixture's own `slice(0, 3)`. */
const DEPLOYS_LIMIT = 3;

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (dataMode !== "live") return <ServiceDetailMock params={params} />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const { id } = await params;
  const [detail, deploys] = await Promise.all([
    getService(forWorkspace(session.workspaceId), id),
    listServiceDeploys(session.workspaceId, id, DEPLOYS_LIMIT, queryRows),
  ]);

  return <ServiceDetailLive name={id} detail={detail} deploys={deploys} />;
}
