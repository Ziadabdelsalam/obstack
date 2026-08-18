import { TRACE_PAGE_SIZE, dataForSession, referenceNowMs } from "@/server/data";
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
 *
 * That read is scoped to the signed-in session's workspace (D113): this page
 * never names a workspace, and there is no ambient one it could inherit.
 *
 * The row ages come from one clock sampled here, per request (D50/D64) — the
 * bar is a client component and has no mode to ask.
 */
export default async function TracesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const filters = parseTracesUrl(await searchParams);
  const data = await dataForSession();
  const { traces, total } = await data.searchTraces(toTraceFilter(filters));

  return (
    <TracesSearch
      traces={traces}
      total={total}
      nowMs={referenceNowMs()}
      pageCount={Math.max(1, Math.ceil(total / TRACE_PAGE_SIZE))}
      filters={filters}
    />
  );
}
