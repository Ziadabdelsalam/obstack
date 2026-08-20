import { notFound } from "next/navigation";
import { connection } from "next/server";
import { dataForSession, dataMode, referenceNowMs } from "@/server/data";
import { TraceExplorer } from "@/components/trace/TraceExplorer";
import { usage } from "@/mock/workspace";

/**
 * The Explain leg of this page, resolved per mode. Live mode reads the ONE
 * quota definition (`server/explain/quota.ts`, D226) so the panel's counter,
 * the settings meter and the route's enforcement are the same two numbers;
 * mock mode keeps reading the demo's own `explainRuns` object (D231.5).
 *
 * The live imports are DYNAMIC for D114's reason, the one `dataForSession`
 * gives: the demo product runs with no Postgres and no auth stack present at
 * all, and a top-level import here would drag both in behind a page it renders.
 */
async function explainLeg(): Promise<{ live: boolean; used: number; quota: number }> {
  if (dataMode !== "live") return { live: false, ...usage.explainRuns };
  const [{ getSessionContext }, { getExplainQuota }, { queryRows }] = await Promise.all([
    import("@/server/session"),
    import("@/server/explain/quota"),
    import("@/server/postgres"),
  ]);
  // `dataForSession` below refuses without a session and `getSessionContext` is
  // request-cached, so this is the same session that scoped the trace read.
  const session = await getSessionContext();
  if (!session) notFound();
  return { live: true, ...(await getExplainQuota(session.workspaceId, queryRows)) };
}

export default async function TracePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Nothing here is a request-time API, so without this the route could be
  // prerendered and serve a stale trace as if it were live (D27a). `connection()`
  // is the Next 16 mechanism for exactly that case — see the `connection` API
  // reference: "only necessary when dynamic rendering is required and common
  // Request-time APIs are not used". Mock mode stays static-as-today.
  if (dataMode === "live") await connection();
  // The lookup is scoped to the signed-in session's workspace (D113), so a
  // trace id from another workspace resolves to nothing and this page 404s —
  // the same answer as an id that never existed.
  const data = await dataForSession();
  const trace = await data.getTrace(id);
  if (!trace) notFound();
  // the healthy-run comparison is a mock-corpus lookup, so live traces get no
  // compare link — a diff against a run that never happened (F8)
  // The "started" stat is an age, so it takes the request's clock (D50/D64) —
  // the same one the list ages its rows against.
  return (
    <TraceExplorer
      trace={trace}
      nowMs={referenceNowMs()}
      compareEnabled={dataMode !== "live"}
      explain={await explainLeg()}
    />
  );
}
