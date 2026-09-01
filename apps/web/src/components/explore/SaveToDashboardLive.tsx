"use client";

import { useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import { addWidget, createDashboard } from "@/components/dashboards/actions";
import { MAX_WIDGETS_PER_DASHBOARD, type Dashboard } from "@/lib/dashboard-types";
import type { MetricSeriesQuery } from "@/lib/metrics-types";

/**
 * Explore's "save to dashboard" modal, live-wired (D433). Markup and styling
 * are copied from `SaveToDashboardModal.tsx` — never imported, that component
 * reads the mock `state/workspace-store` (D391) — but this one lists a real,
 * workspace-scoped `dashboards` prop (read by `explore/page.tsx` via
 * `server/dashboards.ts`'s `listDashboards`) and saves through
 * `components/dashboards/actions.ts`'s `createDashboard`/`addWidget`, which
 * resolve the workspace from the session rather than trusting the client.
 *
 * The widget this saves is always `kind: "timeseries"` (D433): explore's "bar"
 * chart type is bars over TIME (`ExploreLive.tsx`'s `ChartComp`/`XAxis
 * dataKey="t"`), never a top-n ranking, so there is no second kind to choose
 * from here. `{metric, type, agg, range, groupBy}` is exactly the query the
 * page resolved; `pinned` starts false — pinning is an editor action on the
 * dashboard itself (D425), not a save-time choice.
 *
 * A refusal (a duplicate name, a full dashboard, a workspace at its cap —
 * D430) is printed HERE, in the modal, so the caller can pick a different
 * dashboard or a different name without losing the query. Only a successful
 * save closes the modal, through `onSaved`, which is where the caller's toast
 * lives (the `ExploreMock.tsx` `onPick`/toast pattern, copied not imported).
 */
export function SaveToDashboardLive({
  dashboards,
  query,
  onClose,
  onSaved,
}: {
  dashboards: Dashboard[];
  query: MetricSeriesQuery;
  onClose: () => void;
  onSaved: (dashboard: Dashboard) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  const title = `${query.metric} · ${query.agg}` + (query.groupBy ? ` by ${query.groupBy}` : "");

  const save = async (dashboardId: string) => {
    setPending(true);
    setRefused(null);
    const result = await addWidget(dashboardId, {
      title,
      kind: "timeseries",
      metric: query.metric,
      type: query.type,
      agg: query.agg,
      range: query.range,
      groupBy: query.groupBy,
      pinned: false,
    });
    setPending(false);
    if (result === null) {
      setRefused("no active session to save into");
      return;
    }
    if ("refused" in result) {
      setRefused(result.refused);
      return;
    }
    onSaved(result.dashboard);
  };

  const createAndSave = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setPending(true);
    setRefused(null);
    const created = await createDashboard(trimmed);
    if (created === null) {
      setPending(false);
      setRefused("no active session to save into");
      return;
    }
    if ("refused" in created) {
      setPending(false);
      setRefused(created.refused);
      return;
    }
    await save(created.dashboard.id);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Save to dashboard"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-mono text-[12px] uppercase tracking-widest text-faint">Save to dashboard</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-0.5 text-faint hover:bg-raised hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {refused && (
          <div className="border-b border-line bg-overlay px-4 py-2.5">
            <p className="font-mono text-[11.5px] text-ink">{refused}</p>
          </div>
        )}

        <div className="max-h-[360px] overflow-y-auto py-1.5">
          {dashboards.map((d) => {
            const full = d.widgets.length >= MAX_WIDGETS_PER_DASHBOARD;
            return (
              <button
                key={d.id}
                type="button"
                disabled={pending || full}
                onClick={() => void save(d.id)}
                className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-raised disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="font-mono text-[12.5px] text-ink">{d.name}</span>
                <span className="font-mono text-[10.5px] text-faint">
                  {full ? "full" : `${d.widgets.length} widget${d.widgets.length === 1 ? "" : "s"}`}
                </span>
              </button>
            );
          })}
        </div>

        <div className="border-t border-line px-4 py-3">
          {creating ? (
            <form onSubmit={(e) => void createAndSave(e)} className="flex items-center gap-2">
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="dashboard name"
                disabled={pending}
                className="flex-1 rounded-md border border-line bg-raised px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-line-strong"
              />
              <button
                type="submit"
                disabled={pending}
                className="rounded-md border border-line-strong bg-raised px-2.5 py-1.5 font-mono text-[11.5px] text-ink hover:bg-overlay disabled:opacity-50"
              >
                create
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="flex items-center gap-1.5 font-mono text-[11.5px] text-faint hover:text-ink"
            >
              <Plus className="h-3.5 w-3.5" />
              new dashboard…
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
