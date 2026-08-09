import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import { alertEvents, alertRules } from "@/mock/intelligence";

const sevStyle = {
  critical: { color: "var(--color-err)", label: "CRITICAL" },
  warning: { color: "var(--color-warn)", label: "WARNING" },
  info: { color: "var(--color-mid)", label: "INFO" },
} as const;

export default function AlertsPage() {
  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Alerts</h1>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" /> New rule
        </button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        {/* recent alerts */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            recent · last 6h
          </h2>
          <div className="space-y-2">
            {alertEvents.map((a) => (
              <div key={a.title} className="rounded-lg border border-line bg-surface p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                    style={{
                      color: sevStyle[a.severity].color,
                      background: `color-mix(in srgb, ${sevStyle[a.severity].color} 12%, transparent)`,
                    }}
                  >
                    {sevStyle[a.severity].label}
                  </span>
                  <h3 className="text-[13.5px] font-medium text-ink">{a.title}</h3>
                  <span className="ml-auto font-mono text-[10.5px] text-faint">{a.time}</span>
                </div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-mid">{a.detail}</p>
                <Link
                  href={a.link}
                  className="mt-2 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                  style={{ color: "var(--color-api)" }}
                >
                  view evidence <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* rules */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            rules · {alertRules.filter((r) => r.enabled).length} active
          </h2>
          <div className="rounded-lg border border-line bg-surface">
            {alertRules.map((r) => (
              <div key={r.name} className="border-b border-line/50 px-3.5 py-2.5 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-medium text-ink">{r.name}</p>
                  <span
                    className="h-3.5 w-6 rounded-full p-px transition-colors"
                    style={{
                      background: r.enabled
                        ? "color-mix(in srgb, var(--color-ok) 45%, var(--color-line))"
                        : "var(--color-line)",
                    }}
                  >
                    <span
                      className="block h-3 w-3 rounded-full bg-ink transition-transform"
                      style={{ transform: r.enabled ? "translateX(10px)" : "none" }}
                    />
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[10.5px] text-mid">{r.condition}</p>
                <p className="mt-0.5 font-mono text-[10px] text-faint">
                  → {r.channel} · last triggered {r.lastTriggered}
                </p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
