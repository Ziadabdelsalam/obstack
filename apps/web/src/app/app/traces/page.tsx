import { TRACE_PAGE_SIZE, searchTraces } from "@/server/data";
import { TracesSearch } from "@/components/traces/TracesSearch";
import { parseTracesUrl, toTraceFilter } from "@/lib/traces-filter";

/**
 * Filters live in the URL and are applied server-side through the facade — over
 * `trace_summaries` in live mode, over the mock modules in mock mode. Reading
 * `searchParams` is a request-time API, which "will opt the page into dynamic
 * rendering at request time" (Next 16 `page.js` file-convention reference), so
 * live rows can never be baked into a prerender (D27a).
 *
 * One read answers the page (D44): `searchTraces` returns the page AND the
 * exact filtered total, so the header's "N of M" is a property of the data. The
 * pre-D44 second, unfiltered, 200-capped read that used to supply M is gone —
 * it could only ever claim rows this page never rendered (D13/D21).
 */
export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const filters = parseTracesUrl(await searchParams);
  const { traces, total } = await searchTraces(toTraceFilter(filters));

  return (
    <TracesSearch
      traces={traces}
      total={total}
      pageCount={Math.max(1, Math.ceil(total / TRACE_PAGE_SIZE))}
      filters={filters}
    />
  );
}
