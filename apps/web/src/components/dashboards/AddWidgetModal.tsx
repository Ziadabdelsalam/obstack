"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { metricCatalog, type GroupBy } from "@/mock/explore";
import type { Widget, WidgetKind } from "@/mock/dashboards";
import { LayerChip } from "@/components/ui/LayerChip";

const KIND_OPTIONS: { value: WidgetKind; label: string }[] = [
  { value: "timeseries", label: "Timeseries" },
  { value: "stat", label: "Stat" },
  { value: "topn", label: "Top N" },
  { value: "table", label: "Table" },
];

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "none" },
  { value: "service", label: "service" },
  { value: "model", label: "model" },
  { value: "route", label: "route" },
];

export function AddWidgetModal({
  onAdd,
  onClose,
}: {
  onAdd: (w: Omit<Widget, "id">) => void;
  onClose: () => void;
}) {
  const [metricId, setMetricId] = useState<string | null>(null);
  const [kind, setKind] = useState<WidgetKind>("timeseries");
  const [groupBy, setGroupBy] = useState<GroupBy>("none");

  const metric = metricCatalog.find((m) => m.id === metricId) ?? null;

  const add = () => {
    if (!metric) return;
    onAdd({ title: metric.name, kind, metricId: metric.id, groupBy });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[10vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add widget"
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-xl border border-line-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-mono text-[12px] uppercase tracking-widest text-faint">Add widget</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-0.5 text-faint hover:bg-raised hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {!metric ? (
          <div className="max-h-[360px] overflow-y-auto py-1.5">
            {metricCatalog.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMetricId(m.id)}
                className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-raised"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-[12.5px] text-ink">{m.name}</span>
                  <LayerChip layer={m.layer} />
                </span>
                <span className="font-mono text-[10.5px] text-faint">{m.unit}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4 px-4 py-4">
            <button
              type="button"
              onClick={() => setMetricId(null)}
              className="font-mono text-[10.5px] text-faint hover:text-ink"
            >
              ← back to metrics
            </button>

            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-ink">{metric.name}</span>
              <LayerChip layer={metric.layer} />
              <span className="font-mono text-[10.5px] text-faint">{metric.unit}</span>
            </div>

            <div>
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">Widget type</p>
              <div className="flex flex-wrap gap-1.5">
                {KIND_OPTIONS.map((k) => (
                  <button
                    key={k.value}
                    type="button"
                    onClick={() => setKind(k.value)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-[11px] ${
                      kind === k.value
                        ? "border-line-strong bg-raised text-ink"
                        : "border-line text-faint hover:text-ink"
                    }`}
                  >
                    {k.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">Group by</p>
              <div className="flex flex-wrap gap-1.5">
                {GROUP_OPTIONS.map((g) => (
                  <button
                    key={g.value}
                    type="button"
                    onClick={() => setGroupBy(g.value)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-[11px] ${
                      groupBy === g.value
                        ? "border-line-strong bg-raised text-ink"
                        : "border-line text-faint hover:text-ink"
                    }`}
                  >
                    {g.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={add}
              className="w-full rounded-md border border-line-strong bg-raised px-3 py-2 font-mono text-[12px] text-ink hover:bg-overlay"
            >
              Add widget
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
