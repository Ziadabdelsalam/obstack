import assert from "node:assert/strict";
import test from "node:test";
import type { ScopedClickHouse } from "@/server/clickhouse";
import type { DashboardWidget } from "@/lib/dashboard-types";
import { loadWidgetResults } from "./widget-results";

// run with: npm test --workspace apps/web -- widget-results
//
// Hermetic (D96/D113): a fake `ch` stands in for ClickHouse, so no seeded
// server is needed to prove the one contract D428 states — a widget's own
// failure is isolated to its own slot, index-aligned, length preserved.

function widget(id: string, metric: string): DashboardWidget {
  return {
    id,
    title: metric,
    kind: "stat",
    metric,
    type: "gauge",
    agg: "avg",
    range: "6h",
    groupBy: null,
    pinned: false,
  };
}

/** Throws for whichever metric name is in `failing`, otherwise answers with zero rows. */
function fakeCh(failing: Set<string>): { ch: ScopedClickHouse; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ch: {
      async queryRows<Row>(_sql: string, params: Record<string, unknown> = {}): Promise<Row[]> {
        const metric = String(params.metric ?? "");
        calls.push(metric);
        if (failing.has(metric)) throw new Error(`ClickHouse is down for ${metric}`);
        return [] as Row[];
      },
    },
  };
}

test("loadWidgetResults: the second widget's throw becomes ok:false for that slot only, length preserved", async () => {
  const widgets = [widget("wdg_1", "metric-1"), widget("wdg_2", "metric-2"), widget("wdg_3", "metric-3")];
  const { ch, calls } = fakeCh(new Set(["metric-2"]));

  const loads = await loadWidgetResults(ch, widgets);

  assert.equal(loads.length, 3);
  assert.equal(loads[0].ok, true);
  assert.equal(loads[1].ok, false);
  assert.equal(loads[2].ok, true);
  // every widget was still queried, index-aligned — the failing one did not
  // short-circuit the others (Promise.all, not a sequential loop).
  assert.deepEqual(new Set(calls), new Set(["metric-1", "metric-2", "metric-3"]));
});

test("loadWidgetResults: all widgets succeeding answers ok:true for every slot", async () => {
  const widgets = [widget("wdg_1", "metric-1"), widget("wdg_2", "metric-2")];
  const { ch } = fakeCh(new Set());

  const loads = await loadWidgetResults(ch, widgets);

  assert.equal(loads.length, 2);
  assert.ok(loads.every((l) => l.ok === true));
});

test("loadWidgetResults: an empty widget list answers an empty list", async () => {
  const { ch } = fakeCh(new Set());
  assert.deepEqual(await loadWidgetResults(ch, []), []);
});

test("loadWidgetResults: every widget failing answers ok:false for every slot, never throws", async () => {
  const widgets = [widget("wdg_1", "metric-1"), widget("wdg_2", "metric-2")];
  const { ch } = fakeCh(new Set(["metric-1", "metric-2"]));

  const loads = await loadWidgetResults(ch, widgets);

  assert.deepEqual(loads, [{ ok: false }, { ok: false }]);
});
