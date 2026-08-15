import "server-only";
import { fmtCost, fmtMs } from "@/lib/format";
import { queryRows, workspaceId } from "@/server/clickhouse";

export type OverviewRange = "1h" | "6h" | "24h";

/** Shaped for the dashboard charts, which read the mock `MetricPoint` today. */
export interface OverviewPoint {
  t: string; // "13:05", UTC
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  tokens: number;
  costUsd: number;
}

/** Shaped for the dashboard stat cards, which read mock `statCards` today. */
export interface OverviewStat {
  label: string;
  value: string;
  delta: string;
  good: boolean;
}

export interface Overview {
  points: OverviewPoint[];
  stats: OverviewStat[];
}

const RANGES: Record<OverviewRange, { hours: number; bucketMinutes: number }> = {
  "1h": { hours: 1, bucketMinutes: 5 },
  "6h": { hours: 6, bucketMinutes: 15 },
  "24h": { hours: 24, bucketMinutes: 60 },
};

/**
 * One trace per row, merged per D7. `max_seen_date` prunes partitions before the
 * exact `min_start` cut is applied to the merged value.
 */
const TRACES_IN_WINDOW = `
    SELECT
        min(min_start)                                                                     AS started,
        sum(error_count)                                                                   AS errors,
        (toUnixTimestamp64Nano(max(max_end)) - toUnixTimestamp64Nano(min(min_start))) / 1000000 AS duration_ms,
        sum(total_input_tokens) + sum(total_output_tokens)                                 AS tokens,
        sum(total_cost_usd)                                                                AS cost
    FROM obstack.trace_summaries
    WHERE workspace_id = {workspace_id:String}
      AND max_seen_date >= toDate(now() - toIntervalHour({window_hours:UInt32}))
    GROUP BY workspace_id, trace_id
    HAVING started >= now() - toIntervalHour({window_hours:UInt32})`;

const POINTS_SQL = `
SELECT
    formatDateTime(toStartOfInterval(started, INTERVAL {bucket_minutes:UInt32} MINUTE, 'UTC'), '%H:%i', 'UTC') AS t,
    toString(count())                                        AS requests,
    toString(countIf(errors > 0))                            AS errors,
    toUInt32(ifNotFinite(quantile(0.5)(duration_ms), 0))     AS p50,
    toUInt32(ifNotFinite(quantile(0.95)(duration_ms), 0))    AS p95,
    toString(sum(tokens))                                    AS tokens,
    sum(cost)                                                AS cost_usd
FROM (${TRACES_IN_WINDOW})
GROUP BY toStartOfInterval(started, INTERVAL {bucket_minutes:UInt32} MINUTE, 'UTC')
ORDER BY toStartOfInterval(started, INTERVAL {bucket_minutes:UInt32} MINUTE, 'UTC')`;

/** Current window against the one before it, so the cards can show a delta. */
const STATS_SQL = `
SELECT
    toString(countIf(cur))                                            AS requests,
    toString(countIf(cur AND errors > 0))                             AS error_traces,
    toUInt32(ifNotFinite(quantileIf(0.95)(duration_ms, cur), 0))      AS p95,
    sumIf(cost, cur)                                                  AS cost_usd,
    toString(countIf(NOT cur))                                        AS prev_requests,
    toString(countIf((NOT cur) AND errors > 0))                       AS prev_error_traces,
    toUInt32(ifNotFinite(quantileIf(0.95)(duration_ms, NOT cur), 0))  AS prev_p95,
    sumIf(cost, NOT cur)                                              AS prev_cost_usd
FROM (
    SELECT *, started >= now() - toIntervalHour({hours:UInt32}) AS cur
    FROM (${TRACES_IN_WINDOW})
)`;

interface PointRow {
  t: string;
  requests: string;
  errors: string;
  p50: number;
  p95: number;
  tokens: string;
  cost_usd: number;
}

interface StatsRow {
  requests: string;
  error_traces: string;
  p95: number;
  cost_usd: number;
  prev_requests: string;
  prev_error_traces: string;
  prev_p95: number;
  prev_cost_usd: number;
}

/** "+12%" against the previous window; "—" when there is nothing to compare to. */
function pctChange(
  current: number,
  previous: number,
  lowerIsBetter: boolean,
): Pick<OverviewStat, "delta" | "good"> {
  if (previous === 0) return { delta: "—", good: true };
  const pct = ((current - previous) / previous) * 100;
  return {
    delta: `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(0)}%`,
    good: lowerIsBetter ? current <= previous : current >= previous,
  };
}

/** Error rate moves in points, not percent. */
function ptChange(
  current: number,
  previous: number,
  comparable: boolean,
): Pick<OverviewStat, "delta" | "good"> {
  if (!comparable) return { delta: "—", good: true };
  const pt = current - previous;
  return {
    delta: `${pt >= 0 ? "+" : "−"}${Math.abs(pt).toFixed(1)}pt`,
    good: current <= previous,
  };
}

function toStats(row: StatsRow, range: OverviewRange): OverviewStat[] {
  const requests = Number(row.requests);
  const prevRequests = Number(row.prev_requests);
  const errorRate = requests === 0 ? 0 : (Number(row.error_traces) / requests) * 100;
  const prevErrorRate =
    prevRequests === 0 ? 0 : (Number(row.prev_error_traces) / prevRequests) * 100;
  return [
    {
      label: `requests · ${range}`,
      value: requests.toLocaleString("en-US"),
      ...pctChange(requests, prevRequests, false),
    },
    {
      label: "error rate",
      value: `${errorRate.toFixed(1)}%`,
      ...ptChange(errorRate, prevErrorRate, prevRequests > 0),
    },
    {
      label: "p95 latency",
      value: fmtMs(row.p95),
      ...pctChange(row.p95, row.prev_p95, true),
    },
    {
      label: `LLM cost · ${range}`,
      value: fmtCost(row.cost_usd),
      ...pctChange(row.cost_usd, row.prev_cost_usd, true),
    },
  ];
}

export async function queryOverview(range: OverviewRange): Promise<Overview> {
  const { hours, bucketMinutes } = RANGES[range];
  const [pointRows, statsRows] = await Promise.all([
    queryRows<PointRow>(POINTS_SQL, {
      workspace_id: workspaceId,
      window_hours: hours,
      bucket_minutes: bucketMinutes,
    }),
    // the stats query compares the window with the one before it, so it reads twice as far back
    queryRows<StatsRow>(STATS_SQL, {
      workspace_id: workspaceId,
      window_hours: hours * 2,
      hours,
    }),
  ]);

  return {
    points: pointRows.map((row) => ({
      t: row.t,
      requests: Number(row.requests),
      errors: Number(row.errors),
      p50: row.p50,
      p95: row.p95,
      tokens: Number(row.tokens),
      costUsd: row.cost_usd,
    })),
    stats: toStats(statsRows[0], range),
  };
}
