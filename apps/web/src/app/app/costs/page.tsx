import { redirect } from "next/navigation";
import { connection } from "next/server";
import { CostsLive } from "@/components/costs/CostsLive";
import { CostsMock } from "@/components/costs/CostsMock";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { parseCostsRange, queryCosts } from "@/server/queries/costs";
import { getSessionContext } from "@/server/session";

/**
 * Costs, live-wired (D367): a server component branching on `dataMode` (the
 * `services/page.tsx` idiom), never the `data.ts` facade — the live branch
 * reads T3's frozen `queryCosts` directly and hands `CostsLive` nothing but
 * resolved, server-fetched props. The mock branch renders `CostsMock`
 * verbatim, with zero props, before any await, so the rendered DOM there is
 * unchanged.
 *
 * `?range=` (D462) is read AFTER the mock branch — the same ordering as
 * `settings/page.tsx`'s D125: the mock render never depends on the URL, so
 * awaiting the request-time `searchParams` above the mode check would only
 * cost the mock build its prerenderability for a branch it never takes.
 */
export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  if (dataMode !== "live") return <CostsMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const params = await searchParams;
  const range = parseCostsRange(Array.isArray(params.range) ? params.range[0] : params.range);

  return <CostsLive report={await queryCosts(forWorkspace(session.workspaceId), range)} />;
}
