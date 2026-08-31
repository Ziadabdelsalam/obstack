import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ExploreLive } from "@/components/explore/ExploreLive";
import { ExploreMock } from "@/components/explore/ExploreMock";
import type { MetricAgg, MetricRange, MetricSeriesQuery } from "@/lib/metrics-types";
import { forWorkspace } from "@/server/clickhouse";
import { dataMode } from "@/server/data";
import { listMetricCatalog, queryMetricSeries } from "@/server/queries/metrics";
import { getSessionContext } from "@/server/session";
import { activeSeriesCount, SERIES_CAP } from "./series-cap";

const RANGES: MetricRange[] = ["1h", "6h", "24h"];
const isRange = (v: unknown): v is MetricRange => RANGES.includes(v as MetricRange);

/** Validity by type (D363 §0) — used only to keep a stale/hand-edited deep
 *  link from ever reaching `queryMetricSeries` with a combination it would
 *  refuse; the UI itself never offers one (`ExploreLive`'s own copy of this
 *  table). Kept here rather than imported: this file is the one place both
 *  the server-only validity rule and the client vocabulary would otherwise
 *  need a shared module for a five-line table. */
const VALID_AGGS: Record<"gauge" | "sum" | "histogram", MetricAgg[]> = {
  gauge: ["avg", "min", "max", "last"],
  sum: ["sum", "rate"],
  histogram: ["p50", "p90", "p95", "p99", "avg"],
};

/**
 * Explore, live-wired (D367): a server component branching on `dataMode` (the
 * `connections/page.tsx:36` idiom), never the `data.ts` facade — the live
 * branch reads T6's frozen contract directly and feeds `ExploreLive` nothing
 * but resolved, server-fetched props. The mock branch renders `ExploreMock`
 * verbatim, with zero props, so the rendered DOM there is unchanged.
 *
 * Filters live in the URL (the `TracesSearch`/`LogsExplorer` house pattern):
 * every read below is scoped to the session's own workspace (D113), and a
 * request that names a metric/range/agg/group combination the contract would
 * refuse to answer falls back to an honest empty result instead of crashing —
 * the UI itself never constructs such a combination, so this only guards a
 * hand-edited or stale link.
 */
export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (dataMode !== "live") return <ExploreMock />;
  await connection();

  const session = await getSessionContext();
  if (!session) redirect("/login");

  const ch = forWorkspace(session.workspaceId);
  // Two independent reads, in parallel (the `connections/page.tsx:50` idiom):
  // the discovered catalog and the workspace's active-series count, which the
  // cap banner states from `metric_series` itself rather than inferring.
  const [catalog, active] = await Promise.all([listMetricCatalog(ch), activeSeriesCount(ch)]);

  const params = await searchParams;
  const requestedMetric = typeof params.metric === "string" ? params.metric : undefined;
  const requestedType = typeof params.type === "string" ? params.type : undefined;
  // D384: `type` joins `metric` as the selection key — a name D378 genuinely
  // dual-emitted as two types needs BOTH to name one catalog row. An exact
  // pair match wins; a name-only match (an older deep link, or `type` missing)
  // still resolves to something rather than falling straight to the default,
  // same honest-degrade posture as every other param below.
  const selected =
    catalog.find((m) => m.name === requestedMetric && m.type === requestedType) ??
    catalog.find((m) => m.name === requestedMetric) ??
    catalog[0] ??
    null;

  if (!selected) {
    return (
      <ExploreLive
        catalog={catalog}
        query={null}
        result={{ series: [], totalGroups: 0 }}
        seriesCap={SERIES_CAP}
        capReached={active >= SERIES_CAP}
      />
    );
  }

  const range: MetricRange = isRange(params.range) ? params.range : "1h";
  const requestedAgg = typeof params.agg === "string" ? params.agg : undefined;
  const agg: MetricAgg =
    requestedAgg && (VALID_AGGS[selected.type] as string[]).includes(requestedAgg)
      ? (requestedAgg as MetricAgg)
      : VALID_AGGS[selected.type][0];
  const requestedGroup = typeof params.group === "string" ? params.group : undefined;
  const groupBy = requestedGroup && selected.attrKeys.includes(requestedGroup) ? requestedGroup : null;

  const query: MetricSeriesQuery = { metric: selected.name, type: selected.type, range, agg, groupBy, filters: {} };
  const result = await queryMetricSeries(ch, query);

  return (
    <ExploreLive
      catalog={catalog}
      query={query}
      result={result}
      seriesCap={SERIES_CAP}
      capReached={active >= SERIES_CAP}
    />
  );
}
