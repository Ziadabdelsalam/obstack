import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import { slos } from "@/mock/slos";

const statusStyle = {
  healthy: { color: "var(--color-ok)", label: "HEALTHY" },
  "at-risk": { color: "var(--color-warn)", label: "AT RISK" },
  breached: { color: "var(--color-err)", label: "BREACHED" },
} as const;

export default function SlosPage() {
  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">SLOs</h1>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" /> New SLO
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2" data-tour="slos">
        {slos.map((s) => {
          const st = statusStyle[s.status];
          return (
            <section
              key={s.name}
              className="rounded-lg border bg-surface p-4"
              style={{
                borderColor:
                  s.status === "healthy"
                    ? "var(--color-line)"
                    : `color-mix(in srgb, ${st.color} 40%, var(--color-line))`,
              }}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[14.5px] font-semibold text-ink">{s.name}</h2>
                <span
                  className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                  style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}
                >
                  {st.label}
                </span>
                <span className="ml-auto font-mono text-[10.5px] text-faint">{s.window}</span>
              </div>
              <p className="mt-1 font-mono text-[11.5px] text-mid">{s.objective}</p>

              <div className="mt-3 flex items-baseline gap-4">
                <span className="font-mono text-[24px] font-medium text-ink">{s.current}%</span>
                <span className="font-mono text-[11px] text-faint">target {s.target}%</span>
              </div>

              {/* error budget burn */}
              <div className="mt-2.5">
                <div className="mb-1 flex justify-between font-mono text-[10px] text-faint">
                  <span>error budget consumed</span>
                  <span style={{ color: s.budgetBurnedPct >= 75 ? st.color : "var(--color-faint)" }}>
                    {s.budgetBurnedPct}%
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${s.budgetBurnedPct}%`,
                      background:
                        s.budgetBurnedPct >= 75
                          ? st.color
                          : "color-mix(in srgb, var(--color-api) 70%, transparent)",
                    }}
                  />
                </div>
              </div>

              {s.note && (
                <p className="mt-2.5 text-[12px] leading-relaxed text-mid">{s.note}</p>
              )}
              <Link
                href={s.link}
                className="mt-2 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                style={{ color: "var(--color-api)" }}
              >
                inspect <ArrowUpRight className="h-3 w-3" />
              </Link>
            </section>
          );
        })}
      </div>
    </div>
  );
}
