import { redirect } from "next/navigation";
import { connection } from "next/server";
import { InfraLive } from "@/components/infra/InfraLive";
import { InfraMock } from "@/components/infra/InfraMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { queryInfraSnapshot } from "@/server/queries/infra";
import { getSessionContext } from "@/server/session";

/**
 * The infrastructure surface, live-wired (D367): a server component branching
 * on `dataMode` before its first `await`, never the `data.ts` facade — the live
 * branch reads `server/queries/infra.ts` directly and hands `InfraLive` one
 * resolved, server-fetched snapshot. The mock branch renders `InfraMock`
 * verbatim, with zero props, so the rendered DOM there is unchanged.
 *
 * ONE fixed window (D456): `queryInfraSnapshot` takes no range — freshness is
 * `INFRA_STALE_MINUTES` and the right-sizing window is 24h, both fixed in the
 * contract — so there is nothing about time for this page to parse or pass on.
 */
export default async function InfraPage() {
  if (dataMode !== "live") return <InfraMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  return <InfraLive snapshot={await queryInfraSnapshot(forWorkspace(session.workspaceId))} />;
}
