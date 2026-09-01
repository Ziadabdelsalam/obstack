import Link from "next/link";
import { MAX_DASHBOARDS, type Dashboard } from "@/lib/dashboard-types";
import { CreateDashboardForm } from "./DashboardEditor";

/**
 * The dashboards list, live (D367/D431): a SERVER component fed exclusively by
 * `server/dashboards.ts` through `dashboards/page.tsx`. No `@/mock/` import and
 * no `workspace-store` anywhere in this file — the fixture list's owner and its
 * "updated 2h ago" have no stored counterpart, so they are absent rather than
 * invented (D13); what a row states is the name someone typed, how many widgets
 * it holds, and when the store last changed it.
 *
 * The one interactive part is the create form next door (a client component,
 * D392): everything else here is a `<Link>`.
 */
export function DashboardsLive({ dashboards }: { dashboards: Dashboard[] }) {
  const full = dashboards.length >= MAX_DASHBOARDS;

  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Dashboards</h1>
        {/* D402: the cap is stated before it bites, not only when it refuses. */}
        <span className="font-mono text-[11px] text-faint">
          {dashboards.length} of {MAX_DASHBOARDS} per workspace
        </span>
      </div>
      <p className="mb-4 font-mono text-[10.5px] text-faint">
        every dashboard in this workspace, visible to everyone signed into it. Widgets read the
        metrics you have sent — nothing here is seeded.
      </p>

      <CreateDashboardForm full={full} />

      {dashboards.length === 0 ? (
        <section className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">
            no dashboards yet — create one, or save a chart from Explore
          </p>
          <Link
            href="/app/explore"
            className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink"
          >
            open Explore →
          </Link>
        </section>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {dashboards.map((d) => (
            <Link
              key={d.id}
              href={`/app/dashboards/${d.id}`}
              className="rounded-lg border border-line bg-surface p-3.5 hover:border-line-strong hover:bg-raised"
            >
              <h2 className="font-mono text-[13.5px] font-medium text-ink">{d.name}</h2>
              <p className="mt-1 font-mono text-[11px] text-faint">
                updated {d.updatedAt.slice(0, 16).replace("T", " ")} UTC
              </p>
              <p className="mt-2.5 font-mono text-[10.5px] text-mid">
                {d.widgets.length} widget{d.widgets.length === 1 ? "" : "s"}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
