"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import {
  metricCatalog,
  serviceOptions,
  type ExploreQuery,
  type GroupBy,
} from "@/mock/explore";
import { layerLabel, layerOrder } from "@/lib/layers";
import { useWorkspace } from "@/state/workspace-store";
import { ExploreChart } from "@/components/explore/ExploreChart";
import { SaveToDashboardModal } from "@/components/explore/SaveToDashboardModal";

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "none" },
  { value: "service", label: "service" },
  { value: "model", label: "model" },
  { value: "route", label: "route" },
];

const RANGE_OPTIONS: { value: 1 | 6 | 24; label: string }[] = [
  { value: 1, label: "1h" },
  { value: 6, label: "6h" },
  { value: 24, label: "24h" },
];

const CHART_OPTIONS: { value: "line" | "area" | "bar"; label: string }[] = [
  { value: "line", label: "line" },
  { value: "area", label: "area" },
  { value: "bar", label: "bar" },
];

function ChipGroup<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[10.5px] ${
              value === o.value
                ? "border-line-strong bg-raised text-ink"
                : "border-line text-faint hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ExplorePage() {
  const { addWidget, dashboards } = useWorkspace();
  const [query, setQuery] = useState<ExploreQuery>({
    metricId: metricCatalog[0].id,
    service: "all",
    env: "prod",
    groupBy: "none",
    rangeHours: 6,
  });
  const [chartType, setChartType] = useState<"line" | "area" | "bar">("line");
  const [showSave, setShowSave] = useState(false);
  const [toast, setToast] = useState<{ dashboardId: string; dashboardName: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const metric = metricCatalog.find((m) => m.id === query.metricId) ?? metricCatalog[0];

  const set = <K extends keyof ExploreQuery>(key: K, value: ExploreQuery[K]) =>
    setQuery((q) => ({ ...q, [key]: value }));

  const onPick = (dashboardId: string) => {
    const dashboardName = dashboards.find((d) => d.id === dashboardId)?.name ?? "dashboard";
    addWidget(dashboardId, {
      title: `${metric.name}${query.groupBy !== "none" ? ` by ${query.groupBy}` : ""}`,
      kind: chartType === "bar" ? "topn" : "timeseries",
      metricId: query.metricId,
      groupBy: query.groupBy,
    });
    setToast({ dashboardId, dashboardName });
  };

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-line px-3 py-4">
        <h2 className="mb-2 px-1 font-mono text-[11px] uppercase tracking-widest text-faint">Metrics</h2>
        {layerOrder.map((layer) => {
          const metrics = metricCatalog.filter((m) => m.layer === layer);
          if (metrics.length === 0) return null;
          return (
            <div key={layer} className="mb-3">
              <p className="mb-1 px-1 font-mono text-[9.5px] uppercase tracking-widest text-faint">
                {layerLabel[layer]}
              </p>
              <div className="space-y-0.5">
                {metrics.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => set("metricId", m.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] ${
                      m.id === query.metricId ? "bg-raised text-ink" : "text-mid hover:bg-raised hover:text-ink"
                    }`}
                  >
                    <span className="truncate">{m.name}</span>
                    <span className="shrink-0 font-mono text-[9.5px] text-faint">{m.unit}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </aside>

      <main className="flex-1 overflow-y-auto px-5 py-4">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-[19px] font-semibold text-ink">{metric.name}</h1>
            <p className="mt-0.5 font-mono text-[11px] text-faint">{metric.unit}</p>
          </div>
          <button
            type="button"
            onClick={() => setShowSave(true)}
            className="flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12px] text-ink hover:bg-overlay"
          >
            <Plus className="h-3.5 w-3.5" />
            Save to dashboard
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-5 rounded-lg border border-line bg-surface p-3.5">
          <ChipGroup
            label="service"
            options={serviceOptions.map((s) => ({ value: s, label: s }))}
            value={query.service}
            onChange={(v) => set("service", v)}
          />
          <ChipGroup
            label="env"
            options={[
              { value: "prod", label: "prod" },
              { value: "staging", label: "staging" },
            ]}
            value={query.env}
            onChange={(v) => set("env", v)}
          />
          <ChipGroup label="group by" options={GROUP_OPTIONS} value={query.groupBy} onChange={(v) => set("groupBy", v)} />
          <ChipGroup
            label="range"
            options={RANGE_OPTIONS}
            value={query.rangeHours}
            onChange={(v) => set("rangeHours", v)}
          />
          <ChipGroup label="chart" options={CHART_OPTIONS} value={chartType} onChange={setChartType} />
        </div>

        <div className="rounded-lg border border-line bg-surface p-3.5">
          <ExploreChart query={query} chartType={chartType} />
        </div>
      </main>

      {showSave && <SaveToDashboardModal onPick={onPick} onClose={() => setShowSave(false)} />}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-line bg-overlay px-4 py-3">
          <p className="font-mono text-[11.5px] text-ink">Widget saved to {toast.dashboardName}</p>
          <Link
            href={`/app/dashboards/${toast.dashboardId}`}
            className="font-mono text-[11.5px] text-faint underline hover:text-ink"
          >
            View
          </Link>
        </div>
      )}
    </div>
  );
}
