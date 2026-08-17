import { notFound } from "next/navigation";
import { connection } from "next/server";
import { dataMode, getTrace, referenceNowMs } from "@/server/data";
import { TraceExplorer } from "@/components/trace/TraceExplorer";

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
  const trace = await getTrace(id);
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
    />
  );
}
