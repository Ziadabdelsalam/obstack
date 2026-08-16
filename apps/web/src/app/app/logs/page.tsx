import { DEFAULT_LOG_RANGE, LOG_RANGES, SEVERITY_ORDER, searchLogs } from "@/server/data";
import type { LogRange } from "@/server/data";
import { LogsExplorer } from "@/components/logs/LogsExplorer";
import type { Severity } from "@/lib/types";

type Param = string | string[] | undefined;

function one(value: Param): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Absent or unrecognised = no floor, the surface's "severity: all". */
function toSeverity(value: Param): Severity {
  const v = one(value);
  return SEVERITY_ORDER.includes(v as Severity) ? (v as Severity) : "debug";
}

/**
 * Absent or unrecognised = the D50 product-wide default.
 *
 * `Object.hasOwn`, never `v in LOG_RANGES`: `in` walks the prototype chain, so
 * `?range=toString` resolved to `Function.prototype.toString`, made the window
 * `NaN` and 500'd the route in live mode (silently emptied it in mock) instead
 * of falling back to the default this comment promises.
 */
function toRange(value: Param): LogRange {
  const v = one(value);
  return Object.hasOwn(LOG_RANGES, v) ? (v as LogRange) : DEFAULT_LOG_RANGE;
}

/**
 * Every filter lives in the URL and is applied server-side through the facade —
 * over `obstack.logs` in live mode, over the mock stream in mock mode. Reading
 * `searchParams` is a request-time API, which "will opt the page into dynamic
 * rendering at request time" (Next 16 `page.js` file-convention reference), so
 * live rows can never be baked into a prerender (D27a) and the manual refresh
 * (D48) really re-reads the table.
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const filters = {
    q: one(sp.q),
    sev: toSeverity(sp.sev),
    pod: one(sp.pod),
    onTrace: one(sp.onTrace) === "1",
    range: toRange(sp.range),
  };

  const result = await searchLogs({
    q: filters.q,
    minSeverity: filters.sev,
    pod: filters.pod,
    onTraceOnly: filters.onTrace,
    rangeMs: LOG_RANGES[filters.range],
  });

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
