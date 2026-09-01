import Link from "next/link";
import { WidgetLive } from "@/components/dashboards/WidgetLive";
import type { PinnedWidget, WidgetLoad } from "@/lib/dashboard-types";

/**
 * The overview's watch slot, live (S6.3, D425): a VIEW over every widget
 * pinned across the workspace's dashboards — dashboard-list order then widget
 * order, exactly `lib/widget-view.ts`'s `pinnedWidgets()` — never a dashboard
 * of its own (no "Overview watch" row, no reserved id, no create-on-read).
 *
 * Server component, zero fetching: `app/app/page.tsx`'s live branch already
 * ran `listDashboards` → `pinnedWidgets` → `loadWidgetResults` (D428) and
 * hands this file the two resulting, index-aligned arrays. Each card is a
 * `WidgetLive` (T2) linking back to its home dashboard; the mock counterpart,
 * `WatchWidgets.tsx`, is byte-identical and untouched (D438) and carries the
 * SAME `data-tour="watches"` anchor so the product tour has something to
 * spotlight in either mode.
 */
export function WatchWidgetsLive({
  pinned,
  loads,
}: {
  pinned: PinnedWidget[];
  /** This widget's own slot from `loadWidgetResults`, index-aligned with `pinned`. */
  loads: WidgetLoad[];
}) {
  return (
    <div data-tour="watches">
      <div className="mt-4 mb-2 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
          pinned from your dashboards · {pinned.length}
        </h2>
      </div>

      {pinned.length === 0 ? (
        <section className="rounded-lg border border-dashed border-line-strong bg-surface/50 p-6 text-center">
          <p className="font-mono text-[13px] text-faint">
            nothing pinned to the overview yet — pin a widget from any dashboard
          </p>
          <Link
            href="/app/dashboards"
            className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink"
          >
            dashboards
          </Link>
        </section>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {pinned.map((p, i) => (
            <WidgetLive
              key={p.widget.id}
              widget={p.widget}
              load={loads[i]}
              href={`/app/dashboards/${p.dashboardId}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
