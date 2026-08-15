import { listTraces } from "@/server/data";
import { TracesSearch } from "@/components/traces/TracesSearch";

const statuses = ["all", "ok", "error"] as const;
type Status = (typeof statuses)[number];

type Param = string | string[] | undefined;

function one(value: Param): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function positive(value: Param): number {
  const n = Number(one(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function toStatus(value: Param): Status {
  const v = one(value);
  return statuses.includes(v as Status) ? (v as Status) : "all";
}

/**
 * Filters live in the URL and are applied server-side through the facade — over
 * `trace_summaries` in live mode, over the mock modules in mock mode. Reading
 * `searchParams` is a request-time API, which "will opt the page into dynamic
 * rendering at request time" (Next 16 `page.js` file-convention reference), so
 * live rows can never be baked into a prerender (D27a).
 */
export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const filter = {
    q: one(sp.q),
    status: toStatus(sp.status),
    minMs: positive(sp.minMs),
    minCostUsd: positive(sp.minCost),
  };

  // The header reads "N of M traces". M is a second, unfiltered read — worth a
  // query only when a filter is actually narrowing; otherwise the two calls are
  // the same query and N is M.
  const narrowed =
    filter.q !== "" || filter.status !== "all" || filter.minMs > 0 || filter.minCostUsd > 0;
  const [traces, unfiltered] = await Promise.all([
    listTraces(filter),
    narrowed ? listTraces() : undefined,
  ]);

  return (
    <TracesSearch
      traces={traces}
      total={unfiltered?.length ?? traces.length}
      q={filter.q}
      status={filter.status}
      minMs={filter.minMs}
      minCost={filter.minCostUsd}
    />
  );
}
