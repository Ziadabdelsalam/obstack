import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ServiceDetailLive } from "@/components/services/ServiceDetailLive";
import { ServiceDetailMock } from "@/components/services/ServiceDetailMock";
import { deploys } from "@/mock/intelligence";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { getService } from "@/server/queries/services";
import { getSessionContext } from "@/server/session";

/**
 * One service, live-wired (D367), same shape as the catalog above it. The mock
 * branch hands `ServiceDetailMock` the `params` PROMISE rather than awaiting
 * it here: the moved body awaits it exactly as it always did, which is what
 * keeps the mock branch ahead of every await on this page and its DOM
 * unchanged.
 *
 * D401: this file's ONE `@/mock/` import is the deploys fixture, passed to
 * `ServiceDetailLive` as a prop — the page-level static mock import beside the
 * `dataMode` branch is the ratified `connections/page.tsx:11,37` idiom (D391b),
 * and it keeps the live component itself free of mock data. The panel renders
 * in live mode under a `SampleMark` rather than disappearing (D362): deploy
 * tracking is a real M6 surface, and hiding it would hide the roadmap too.
 *
 * The `[id]` segment carries the SERVICE NAME in live mode (`spans.service` is
 * the identity — there is no separate id to look up); Next decodes it.
 */
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
  const detail = await getService(forWorkspace(session.workspaceId), id);

  return <ServiceDetailLive name={id} detail={detail} deploys={deploys.slice(0, 3)} />;
}
