import "server-only";
import { queryMetricSeries } from "@/server/queries/metrics";
import type { ScopedClickHouse } from "@/server/clickhouse";
import { widgetQuery } from "@/lib/widget-view";
import type { DashboardWidget, WidgetLoad } from "@/lib/dashboard-types";

/**
 * The one shared read behind every dashboard/overview surface (D428):
 * `queryMetricSeries` for every widget in parallel, index-aligned with the
 * input, each widget's own failure isolated to `{ ok: false }` for that slot
 * — a bad or slow widget never takes the rest of the page down with it
 * (`WidgetLive` prints "couldn't load this widget" for that card alone).
 */
export async function loadWidgetResults(
  ch: ScopedClickHouse,
  widgets: DashboardWidget[],
): Promise<WidgetLoad[]> {
  return Promise.all(
    widgets.map(
      async (w): Promise<WidgetLoad> => {
        try {
          return { ok: true, result: await queryMetricSeries(ch, widgetQuery(w)) };
        } catch {
          return { ok: false };
        }
      },
    ),
  );
}
