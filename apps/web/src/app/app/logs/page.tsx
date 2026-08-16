import { parseLogsUrl, toLogFilter } from "@/lib/logs-filter";
import { searchLogs } from "@/server/data";
import { LogsExplorer } from "@/components/logs/LogsExplorer";

/**
 * Every filter lives in the URL and is applied server-side through the facade —
 * over `obstack.logs` in live mode, over the mock stream in mock mode. The
 * parsing, the defaults and the parameter names are the surface's URL contract
 * (`@/lib/logs-filter`, D65), shared with the filter bar so the two halves of
 * one round trip cannot disagree.
 *
 * Reading `searchParams` is a request-time API, which "will opt the page into
 * dynamic rendering at request time" (Next 16 `page.js` file-convention
 * reference), so live rows can never be baked into a prerender (D27a) and the
 * manual refresh (D48) really re-reads the table.
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const filters = parseLogsUrl(await searchParams);
  const result = await searchLogs(toLogFilter(filters));

  return (
    <LogsExplorer
      {...filters}
      logs={result.logs}
      pods={result.pods}
      truncated={result.truncated}
      nowMs={result.nowMs}
    />
  );
}
