"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useWorkspace } from "@/state/workspace-store";

export default function DashboardsPage() {
  const { dashboards, createDashboard } = useWorkspace();
  const router = useRouter();

  const onNew = () => {
    const id = createDashboard("Untitled dashboard");
    router.push(`/app/dashboards/${id}`);
  };

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Dashboards</h1>
        <button
          type="button"
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12px] text-ink hover:bg-overlay"
        >
          <Plus className="h-3.5 w-3.5" />
          New dashboard
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {dashboards.map((d) => (
          <Link
            key={d.id}
            href={`/app/dashboards/${d.id}`}
            className="rounded-lg border border-line bg-surface p-3.5 hover:border-line-strong hover:bg-raised"
          >
            <h2 className="font-mono text-[13.5px] font-medium text-ink">{d.name}</h2>
            <p className="mt-1 font-mono text-[11px] text-faint">
              {d.owner} · updated {d.updated}
            </p>
            <p className="mt-2.5 font-mono text-[10.5px] text-mid">
              {d.widgets.length} widget{d.widgets.length === 1 ? "" : "s"}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
