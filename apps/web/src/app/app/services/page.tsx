import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ServicesLive } from "@/components/services/ServicesLive";
import { ServicesMock } from "@/components/services/ServicesMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { listServices } from "@/server/queries/services";
import { getSessionContext } from "@/server/session";

/**
 * The service catalog, live-wired (D367): a server component branching on
 * `dataMode` (the `connections/page.tsx:36` idiom), never the `data.ts`
 * facade — the live branch reads `server/queries/services.ts` directly and
 * hands `ServicesLive` nothing but resolved, server-fetched props. The mock
 * branch renders `ServicesMock` verbatim, with zero props, before any await,
 * so the rendered DOM there is unchanged.
 *
 * ONE fixed window (D394): `listServices` takes no range, so there is nothing
 * about time for this page to parse or pass on.
 */
export default async function ServicesPage() {
  if (dataMode !== "live") return <ServicesMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  return <ServicesLive list={await listServices(forWorkspace(session.workspaceId))} />;
}
