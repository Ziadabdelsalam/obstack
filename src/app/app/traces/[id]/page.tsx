import { notFound } from "next/navigation";
import { getTrace } from "@/mock/traces";
import { TraceExplorer } from "@/components/trace/TraceExplorer";

export default async function TracePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const trace = getTrace(id);
  if (!trace) notFound();
  return <TraceExplorer trace={trace} />;
}
