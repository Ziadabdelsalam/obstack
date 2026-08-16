"use client";

import { X } from "lucide-react";
import { useWorkspace } from "@/state/workspace-store";

export function SaveToDashboardModal({
  onPick,
  onClose,
}: {
  onPick: (dashboardId: string) => void;
  onClose: () => void;
}) {
  const { dashboards } = useWorkspace();

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

        <div className="max-h-[360px] overflow-y-auto py-1.5">
          {dashboards.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => {
                onPick(d.id);
                onClose();
              }}
              className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left hover:bg-raised"
            >
              <span className="font-mono text-[12.5px] text-ink">{d.name}</span>
              <span className="font-mono text-[10.5px] text-faint">
                {d.widgets.length} widget{d.widgets.length === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
