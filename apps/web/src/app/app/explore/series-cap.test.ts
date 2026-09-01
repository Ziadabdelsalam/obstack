import assert from "node:assert/strict";
import test from "node:test";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { activeSeriesCount } from "./series-cap";

// run with: npm test --workspace apps/web -- series-cap
//
// Hermetic, like metrics.test.ts: nothing here needs a live ClickHouse. The
// seeded-server half lives in series-cap.integration.test.ts. `forWorkspace`'s
// own unscoped-SQL tripwire is proven once, generically, in
// metrics.test.ts/tenancy.test.ts — this file's SQL is fixed rather than
// caller-built, so what it proves instead is that THIS statement carries the
// placeholder (below), not that the generic refusal mechanism exists. The cap
// NUMBER is not restated here: series-cap.parity.test.ts pins it against
// write.go's DefaultSeriesCap by reading the Go source (D385), and a literal
// 25_000 beside it would only be a third place to edit.

type Call = { sql: string; params: Record<string, unknown> };

function recorder(rows: unknown[]): { ch: ScopedClickHouse; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        calls.push({ sql, params });
        return rows as Row[];
      },
    },
  };
}

test("activeSeriesCount: one scoped read against metric_series, never FINAL, never a bare SELECT", async () => {
  const { ch, calls } = recorder([{ active: "42" }]);
  const count = await activeSeriesCount(ch);
  assert.equal(count, 42);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].sql.includes("obstack.metric_series"), "activeSeriesCount did not read metric_series");
  assert.ok(calls[0].sql.includes("{workspace_id:"), "activeSeriesCount sent an unscoped statement");
  assert.ok(!calls[0].sql.includes("FINAL"), "activeSeriesCount must never use FINAL");
  // The full physical merge key (D374), same as CATALOG_SQL's inner subquery
  // — grouping by series_hash alone would risk an arbitrary pick between
  // parts for the other merge-key columns.
  assert.match(calls[0].sql, /GROUP BY workspace_id, name, series_hash, type, unit, service/);
});

test("activeSeriesCount: no rows back is zero active series, not a crash", async () => {
  const { ch } = recorder([]);
  assert.equal(await activeSeriesCount(ch), 0);
});
