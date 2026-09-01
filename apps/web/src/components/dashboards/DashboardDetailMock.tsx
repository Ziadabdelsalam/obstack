"use client";

import { use, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { useWorkspace } from "@/state/workspace-store";
import { WidgetCard } from "@/components/dashboards/WidgetCard";
import { AddWidgetModal } from "@/components/dashboards/AddWidgetModal";

export function DashboardDetailMock({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { dashboards, addWidget, removeWidget, moveWidget } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);

  const dashboard = dashboards.find((d) => d.id === id);

  if (!dashboard) {
    return (
      <div className="px-5 py-4">
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">Dashboard not found.</p>
          <Link href="/app/dashboards" className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink">
            ← back to dashboards
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="font-display text-[19px] font-semibold text-ink">{dashboard.name}</h1>
          <p className="mt-0.5 font-mono text-[11px] text-faint">
            {dashboard.owner} · updated {dashboard.updated}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {editing && (
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12px] text-ink hover:bg-overlay"
            >
              <Plus className="h-3.5 w-3.5" />
              Add widget
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing((e) => !e)}
            className="rounded-md border border-line px-3 py-1.5 font-mono text-[12px] text-faint hover:text-ink"
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      {dashboard.widgets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-8 text-center">
          <p className="font-mono text-[12.5px] text-faint">Add your first widget</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {dashboard.widgets.map((w) => (
            <WidgetCard
              key={w.id}
              widget={w}
              editing={editing}
              onRemove={() => removeWidget(dashboard.id, w.id)}
              onMove={(dir) => moveWidget(dashboard.id, w.id, dir)}
            />
          ))}
        </div>
      )}

      {showAdd && <AddWidgetModal onAdd={(w) => addWidget(dashboard.id, w)} onClose={() => setShowAdd(false)} />}
    </div>
  );
}
