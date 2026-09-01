import Link from "next/link";
import type { Dashboard, WidgetLoad } from "@/lib/dashboard-types";
import type { MetricCatalogEntry } from "@/lib/metrics-types";
import { DashboardEditor } from "./DashboardEditor";

/**
 * One dashboard, live (D367/D431): a SERVER component with zero fetching —
 * `dashboards/[id]/page.tsx` did every read (D428) and this file decides what
 * the reader sees. `dashboard === null` is the tenancy boundary read from the
 * outside: an id from another workspace answers exactly as an invented one
 * does (D436), never a 500 and never the other tenant's row.
 *
 * The mutable body — the widget cards and their controls — is `DashboardEditor`
 * next door, because edit mode is ONE piece of client state shared by the
 * toolbar and every card. This file owns the title, the basis line and the
 * not-found answer; nothing here imports `@/mock/` or the workspace store.
 */
export function DashboardDetailLive({
  dashboard,
  catalog,
  loads,
}: {
  dashboard: Dashboard | null;
  catalog: MetricCatalogEntry[];
  /** Index-aligned with `dashboard.widgets` — one metrics read per widget (D428). */
  loads: WidgetLoad[];
}) {
  if (!dashboard) {
    return (
      <div className="px-5 py-4">
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">no dashboard with this id in your workspace</p>
          <Link
            href="/app/dashboards"
            className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink"
          >
            ← back to dashboards
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-4">
        <h1 className="font-display text-[19px] font-semibold text-ink">{dashboard.name}</h1>
        <p className="mt-0.5 font-mono text-[11px] text-faint">
          {dashboard.widgets.length} widget{dashboard.widgets.length === 1 ? "" : "s"} · updated{" "}
          {dashboard.updatedAt.slice(0, 16).replace("T", " ")} UTC
        </p>
      </div>

      <DashboardEditor dashboard={dashboard} catalog={catalog} loads={loads} />
    </div>
  );
}
