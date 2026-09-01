import "server-only";
import type { ScopedClickHouse } from "@/server/clickhouse";

/**
 * The D363 §2 cardinality cap, mirrored from `DefaultSeriesCap` in
 * `services/ingest/internal/write/write.go`: 25,000 active series per
 * workspace. Ingest is the one place that ENFORCES it (`mapping.NewSeriesCache`
 * admits or drops); this side only reads whether the workspace is currently AT
 * it, so explore's banner can never disagree with the number ingest actually
 * uses. Two languages, one number, stated in both places because a Go
 * constant cannot be imported across the boundary the way a JSON price list
 * can (`server/ingest-health.ts`'s `BASE_PRICES_AS_OF`).
 */
export const SERIES_CAP = 25_000;

/**
 * How many series `metric_series` currently counts as active for this
 * workspace — "last_seen within the current UTC day" (packet §2), the exact
 * definition and UTC boundary `write.go`'s boot reconciliation
 * (`selectActiveSeries`) reads at startup. Never estimated (packet §2's
 * honest-UI rule): a real count over the real table, never derived from the
 * health counters or guessed from a drop having happened in the past.
 *
 * Same merge discipline as `queries/metrics.ts`'s `CATALOG_SQL` (never FINAL,
 * never a bare SELECT): the inner query groups by the table's full physical
 * merge key (D374 — `workspace_id, name, series_hash, type, unit, service`)
 * and finalizes `last_seen`'s own aggregate before the outer query filters by
 * the UTC day and counts the true series identity, `series_hash`.
 */
const ACTIVE_SERIES_SQL = `
SELECT toString(count(DISTINCT series_hash)) AS active
FROM (
    SELECT workspace_id, name, series_hash, toString(type) AS type, unit, service,
           max(last_seen) AS last_seen
    FROM obstack.metric_series
    WHERE workspace_id = {workspace_id:String}
    GROUP BY workspace_id, name, series_hash, type, unit, service
)
WHERE last_seen >= toStartOfDay(now('UTC'))`;

export async function activeSeriesCount(ch: ScopedClickHouse): Promise<number> {
  const [row] = await ch.queryRows<{ active: string }>(ACTIVE_SERIES_SQL);
  return Number(row?.active ?? 0);
}
