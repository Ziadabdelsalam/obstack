"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { categories, connectedSources, connectors } from "@/mock/connectors";
import type { ConnectedSource, Connector } from "@/mock/types";
import { ConnectModal } from "./ConnectModal";

const sourceStatus: Record<
  ConnectedSource["status"],
  { color: string; label: string }
> = {
  healthy: { color: "var(--color-ok)", label: "healthy" },
  degraded: { color: "var(--color-warn)", label: "degraded" },
  silent: { color: "var(--color-err)", label: "no events" },
};

export function ConnectionsHub() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Connector | null>(null);

  const filtered = useMemo(
    () =>
      connectors.filter(
        (c) =>
          c.name.toLowerCase().includes(q.toLowerCase()) ||
          c.category.toLowerCase().includes(q.toLowerCase()) ||
          c.blurb.toLowerCase().includes(q.toLowerCase()),
      ),
    [q],
  );

  const bySlug = new Map(connectors.map((c) => [c.slug, c]));

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[19px] font-semibold text-ink">Connections</h1>
          <p className="mt-0.5 text-[12.5px] text-mid">
            Every source of logs and traces you run, wired into one place.
          </p>
        </div>
        <div className="relative w-64">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search sources…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pr-3 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
        </div>
      </div>

      {/* connected sources */}
      <section className="mb-6 rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-3.5 py-2">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
            connected · {connectedSources.length}
          </h2>
        </div>
        <div className="divide-y divide-line/50">
          {connectedSources.map((s) => {
            const c = bySlug.get(s.connectorSlug);
            const st = sourceStatus[s.status];
            return (
              <div key={s.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2.5">
                <span
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-line bg-raised font-mono text-[10.5px] font-semibold"
                  style={{ color: c?.markColor }}
                >
                  {c?.mark}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] text-ink">{s.name}</p>
                  <p className="font-mono text-[10.5px] text-faint">{c?.name}</p>
                </div>
                <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color: st.color }}>
                  <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: st.color }} />
                  {st.label}
                </span>
                <span className="w-24 text-right font-mono text-[11px] text-mid">
                  {s.ratePerMin.toLocaleString()}/min
                </span>
                <span className="w-20 text-right font-mono text-[11px] text-faint">
                  {s.lastEvent}
                </span>
                <span
                  className="w-16 text-right font-mono text-[11px]"
                  style={{ color: s.errorCount ? "var(--color-warn)" : "var(--color-faint)" }}
                >
                  {s.errorCount ? `${s.errorCount} errs` : "0 errs"}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* catalog */}
      {categories.map((cat) => {
        const items = filtered.filter((c) => c.category === cat);
        if (items.length === 0) return null;
        return (
          <section key={cat} className="mb-6">
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
              {cat}
            </h2>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
              {items.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  onClick={() => setOpen(c)}
                  className="group flex items-start gap-3 rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong hover:bg-raised"
                >
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-raised font-mono text-[13px] font-semibold"
                    style={{ color: c.markColor }}
                  >
                    {c.mark}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-ink">{c.name}</span>
                      {c.status === "available" ? (
                        <span
                          className="rounded-[3px] px-1 py-px font-mono text-[9px] tracking-wide"
                          style={{
                            color: "var(--color-ok)",
                            background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
                          }}
                        >
                          CONNECT
                        </span>
                      ) : (
                        <span className="rounded-[3px] bg-overlay px-1 py-px font-mono text-[9px] tracking-wide text-faint">
                          SOON
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-mid">
                      {c.blurb}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        );
      })}

      {filtered.length === 0 && (
        <p className="py-10 text-center text-[13px] text-faint">
          No sources match “{q}”. Try a different name, or request it — the catalog grows by demand.
        </p>
      )}

      {open && <ConnectModal connector={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
