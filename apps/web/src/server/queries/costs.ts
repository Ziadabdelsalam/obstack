import "server-only";
import {
  COSTS_GROUP_CAP,
  COSTS_RANGES,
  DEFAULT_COSTS_RANGE,
  type CostsPoint,
  type CostsRange,
  type CostsReport,
  type CostsTotals,
} from "@/lib/costs-types";
import type { ScopedClickHouse } from "@/server/clickhouse";

/**
 * Trace-derived LLM unit economics (D460/D461). Every statement here reads
 * `spans` WHERE `layer = 'llm'` — the layer ingest computes at write time (D8)
 * — because that is the only place a per-model or per-service cost exists at
 * all: `trace_summaries` carries `total_cost_usd` with no model and no service
 * dimension (D395's table split).
 *
 * Cost is priced at INGEST (`services/ingest/internal/pricing`), so a model
 * with no price row lands in `cost_usd` as 0, indistinguishable from a call
 * that was genuinely free. Naming those calls is this module's job, not the
 * page's: every grouped read carries `unpricedCalls`, and the unpriced models
 * get a list of their own (D461) — they have cost 0 and would fall straight
 * out of a top-10 ranked by spend.
 */

/** Response model when the provider named one, else what was asked for (`adapters.ts:167`). */
const MODEL = "if(gen_ai_response_model != '', gen_ai_response_model, gen_ai_request_model)";

/**
 * Ingest's no-price-row sentinel (`pricing.go` Cost): tokens moved and nothing
 * was charged. One text, used by every statement that counts or lists unpriced
 * calls, so the page's "unpriced" and the list's "unpriced" cannot drift apart.
 */
const UNPRICED = "input_tokens + output_tokens > 0 AND cost_usd = 0";

/**
 * The scope predicate every statement carries, plus the layer fence. `spans` is
 * `PARTITION BY toDate(start_time)`, so the window bound prunes partitions on
 * its own — no `max_seen_date` pre-filter to add, unlike the summaries reads.
 */
const LLM_IN_WINDOW = `
    WHERE workspace_id = {workspace_id:String}
      AND layer = 'llm'
      AND start_time >= now() - toIntervalHour({window_hours:UInt32})`;

/**
 * D462. `points * bucketMinutes` is exactly the window in every row, so the
 * chart's grid and the numbers above it name the same span of time.
 */
const RANGES: Record<CostsRange, { windowHours: number; bucketMinutes: number; points: number }> = {
  "24h": { windowHours: 24, bucketMinutes: 60, points: 24 },
  "7d": { windowHours: 24 * 7, bucketMinutes: 6 * 60, points: 28 },
  "30d": { windowHours: 24 * 30, bucketMinutes: 24 * 60, points: 30 },
};

/**
 * D402: the cap, the total it truncated, AND the report's totals are ONE
 * answer, so all three ride the same grouped set through window functions
 * rather than a second read that could disagree with them (`services.ts`'s
 * `count() OVER ()`, extended — every LLM span is in exactly one model group,
 * including the ones that named no model, so the `OVER ()` sums ARE the
 * window's totals).
 *
 * The inner aggregates are named apart from the columns they produce: an outer
 * `sum(x) OVER ()` over a subquery alias `x` that is itself `sum(...)` is
 * rejected as an aggregate inside an aggregate (measured against the pinned
 * engine).
 */
const BY_MODEL_SQL = `
SELECT
    model,
    system,
    cost                              AS cost_usd,
    toString(in_tokens)               AS input_tokens,
    toString(out_tokens)              AS output_tokens,
    toString(n_calls)                 AS calls,
    toString(n_unpriced)              AS unpriced_calls,
    toString(count() OVER ())         AS total_models,
    sum(cost) OVER ()                 AS all_cost_usd,
    toString(sum(in_tokens) OVER ())  AS all_input_tokens,
    toString(sum(out_tokens) OVER ()) AS all_output_tokens,
    toString(sum(n_calls) OVER ())    AS all_calls,
    toString(sum(n_unpriced) OVER ()) AS all_unpriced_calls
FROM (
    SELECT
        ${MODEL}             AS model,
        max(gen_ai_system)   AS system,
        sum(cost_usd)        AS cost,
        sum(input_tokens)    AS in_tokens,
        sum(output_tokens)   AS out_tokens,
        count()              AS n_calls,
        countIf(${UNPRICED}) AS n_unpriced
    FROM obstack.spans${LLM_IN_WINDOW}
    GROUP BY model
)
ORDER BY cost DESC, n_calls DESC, model
LIMIT {cap:UInt32}`;

/**
 * Same cap-plus-total shape by the service that made the call. `modelCount` is
 * the distinct model identity, not an array: the surface says "N models", and
 * a service with a hundred of them must not ship a hundred strings to say so.
 */
const BY_SERVICE_SQL = `
SELECT
    service,
    cost                      AS cost_usd,
    toString(n_calls)         AS calls,
    toString(n_unpriced)      AS unpriced_calls,
    toString(n_models)        AS model_count,
    toString(count() OVER ()) AS total_services
FROM (
    SELECT
        service,
        sum(cost_usd)        AS cost,
        count()              AS n_calls,
        countIf(${UNPRICED}) AS n_unpriced,
        uniqExact(${MODEL})  AS n_models
    FROM obstack.spans${LLM_IN_WINDOW}
    GROUP BY service
)
ORDER BY cost DESC, n_calls DESC, service
LIMIT {cap:UInt32}`;

/**
 * D461's own list. An unpriced model's spend is 0 by definition, so it can
 * never place in `BY_MODEL_SQL`'s ranking once a single priced model exists —
 * ranking these by call volume is the only way the page can name them.
 */
const UNPRICED_MODELS_SQL = `
SELECT
    model,
    toString(n_calls)         AS calls,
    toString(count() OVER ()) AS total_unpriced_models
FROM (
    SELECT
        ${MODEL} AS model,
        count()  AS n_calls
    FROM obstack.spans${LLM_IN_WINDOW}
      AND ${UNPRICED}
    GROUP BY model
)
ORDER BY n_calls DESC, model
LIMIT {cap:UInt32}`;

/**
 * Spend over time. The bucket key is epoch seconds rather than a formatted
 * label so the grid below can join on it exactly: `toStartOfInterval` with a
 * MINUTE interval floors on the epoch, which is what the grid computes in
 * TypeScript.
 */
const SERIES_SQL = `
SELECT
    toUInt32(toUnixTimestamp(toStartOfInterval(toDateTime(start_time, 'UTC'), INTERVAL {bucket_minutes:UInt32} MINUTE, 'UTC'))) AS bucket_epoch_s,
    sum(cost_usd)     AS cost_usd,
    toString(count()) AS calls
FROM obstack.spans${LLM_IN_WINDOW}
GROUP BY bucket_epoch_s
ORDER BY bucket_epoch_s`;

interface ModelRowSql {
  model: string;
  system: string;
  cost_usd: number;
  input_tokens: string;
  output_tokens: string;
  calls: string;
  unpriced_calls: string;
  total_models: string;
  all_cost_usd: number;
  all_input_tokens: string;
  all_output_tokens: string;
  all_calls: string;
  all_unpriced_calls: string;
}

interface ServiceRowSql {
  service: string;
  cost_usd: number;
  calls: string;
  unpriced_calls: string;
  model_count: string;
  total_services: string;
}

interface UnpricedRowSql {
  model: string;
  calls: string;
  total_unpriced_models: string;
}

interface SeriesRowSql {
  bucket_epoch_s: number;
  cost_usd: number;
  calls: string;
}

/** No model rows is no LLM calls — every total is 0, which is a fact, not a missing price. */
function totalsOf(rows: ModelRowSql[]): CostsTotals {
  if (rows.length === 0) {
    return { costUsd: 0, inputTokens: 0, outputTokens: 0, calls: 0, unpricedCalls: 0 };
  }
  const row = rows[0];
  return {
    costUsd: row.all_cost_usd,
    inputTokens: Number(row.all_input_tokens),
    outputTokens: Number(row.all_output_tokens),
    calls: Number(row.all_calls),
    unpricedCalls: Number(row.all_unpriced_calls),
  };
}

/**
 * `?range=` from the URL (D462). Anything that is not one of the three ranges
 * is the default — a hand-edited query string is a typo, not an error page.
 */
export function parseCostsRange(raw: string | undefined): CostsRange {
  return (COSTS_RANGES as readonly string[]).includes(raw ?? "")
    ? (raw as CostsRange)
    : DEFAULT_COSTS_RANGE;
}

/**
 * The costs report for one range: four scoped reads in parallel (the
 * `getService` idiom), assembled here.
 *
 * The series grid is built in TypeScript (`metrics.ts`'s idiom), because an
 * hour in which this workspace made no LLM call must render as 0 rather than
 * vanish from the chart — no calls IS no cost (D460), which is the one place
 * on this page where a zero is honest. The grid is the last `points` WHOLE
 * buckets: the window reaches a little further back than the oldest one, so
 * `totals` may exceed the chart's sum by the calls in that partial bucket —
 * the totals are the window's, and the chart is the grid's.
 */
export async function queryCosts(ch: ScopedClickHouse, range: CostsRange): Promise<CostsReport> {
  const { windowHours, bucketMinutes, points } = RANGES[range];
  const bucketSeconds = bucketMinutes * 60;
  const nowFlooredS = Math.floor(Date.now() / 1000 / bucketSeconds) * bucketSeconds;
  const grid = Array.from(
    { length: points },
    (_, i) => nowFlooredS - (points - 1 - i) * bucketSeconds,
  );

  const [modelRows, serviceRows, unpricedRows, seriesRows] = await Promise.all([
    ch.queryRows<ModelRowSql>(BY_MODEL_SQL, { window_hours: windowHours, cap: COSTS_GROUP_CAP }),
    ch.queryRows<ServiceRowSql>(BY_SERVICE_SQL, { window_hours: windowHours, cap: COSTS_GROUP_CAP }),
    ch.queryRows<UnpricedRowSql>(UNPRICED_MODELS_SQL, {
      window_hours: windowHours,
      cap: COSTS_GROUP_CAP,
    }),
    ch.queryRows<SeriesRowSql>(SERIES_SQL, {
      window_hours: windowHours,
      bucket_minutes: bucketMinutes,
    }),
  ]);

  const byBucket = new Map(seriesRows.map((row) => [row.bucket_epoch_s, row]));
  const series: CostsPoint[] = grid.map((epochS) => {
    const row = byBucket.get(epochS);
    return {
      t: new Date(epochS * 1000).toISOString(),
      costUsd: row ? row.cost_usd : 0,
      calls: row ? Number(row.calls) : 0,
    };
  });

  return {
    range,
    totals: totalsOf(modelRows),
    byModel: modelRows.map((row) => ({
      model: row.model,
      system: row.system,
      costUsd: row.cost_usd,
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      calls: Number(row.calls),
      unpricedCalls: Number(row.unpriced_calls),
    })),
    // Every row carries the same window-function total; no rows means no
    // models, which is the only case where the total is not on a row.
    totalModels: modelRows.length === 0 ? 0 : Number(modelRows[0].total_models),
    byService: serviceRows.map((row) => ({
      service: row.service,
      costUsd: row.cost_usd,
      calls: Number(row.calls),
      unpricedCalls: Number(row.unpriced_calls),
      modelCount: Number(row.model_count),
    })),
    totalServices: serviceRows.length === 0 ? 0 : Number(serviceRows[0].total_services),
    unpricedModels: unpricedRows.map((row) => ({ model: row.model, calls: Number(row.calls) })),
    totalUnpricedModels:
      unpricedRows.length === 0 ? 0 : Number(unpricedRows[0].total_unpriced_models),
    series,
  };
}
