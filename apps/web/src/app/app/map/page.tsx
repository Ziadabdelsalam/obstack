import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ServiceMapLive } from "@/components/map/ServiceMapLive";
import { ServiceMapMock } from "@/components/map/ServiceMapMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { queryTopology } from "@/server/queries/topology";
import { getSessionContext } from "@/server/session";

/**
 * The service map, live-wired (D367): a server component branching on
 * `dataMode` (the `connections/page.tsx:36` idiom), never the `data.ts` facade
 * — the live branch reads `queryTopology` directly and hands `ServiceMapLive`
 * nothing but resolved, server-fetched props. The mock branch renders
 * `ServiceMapMock` verbatim, with zero props, so the demo's DOM is unchanged.
 *
 * One read answers the page: the topology carries its own nodes, edges, the
 * pre-cap service total the banner states, and the cap itself. There is no
 * range to pass (D394) — the window is the contract's.
 */
export default async function MapPage() {
  if (dataMode !== "live") return <ServiceMapMock />;
  await connection();

  const session = await getSessionContext();
  // The layout redirects too, but a layout does not control whether the segment
  // below it renders: this page resolves its own session rather than reading a
  // workspace off a null.
  if (!session) redirect("/login");

  const topology = await queryTopology(forWorkspace(session.workspaceId));
  return <ServiceMapLive topology={topology} />;
}
