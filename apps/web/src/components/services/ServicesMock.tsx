import Link from "next/link";
import { services, grade } from "@/mock/catalog";
import { LayerChip } from "@/components/ui/LayerChip";

const gradeColor = {
  A: "var(--color-ok)",
  B: "var(--color-infra)",
  C: "var(--color-warn)",
  D: "var(--color-err)",
} as const;

const sloStyle = {
  healthy: { color: "var(--color-ok)", label: "healthy" },
  "at-risk": { color: "var(--color-warn)", label: "at-risk" },
  breached: { color: "var(--color-err)", label: "breached" },
  none: { color: "var(--color-faint)", label: "none" },
} as const;

export function ServicesMock() {
  const gradeACount = services.filter((s) => grade(s) === "A").length;

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Service catalog</h1>
        <span className="font-mono text-[11px] text-faint">
          {services.length} services · {gradeACount} grade A
        </span>
      </div>

      <section className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
              <th className="py-2 pl-3.5 font-medium">service</th>
              <th className="py-2 font-medium">layer</th>
              <th className="py-2 font-medium">team</th>
              <th className="py-2 font-medium">tier</th>
              <th className="py-2 font-medium">runtime</th>
              <th className="py-2 text-right font-medium">deps</th>
              <th className="py-2 font-medium">slo</th>
              <th className="py-2 pr-3.5 text-right font-medium">grade</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => {
              const slo = sloStyle[s.sloStatus];
              const g = grade(s);
              return (
                <tr key={s.id} className="border-b border-line/50 last:border-0">
                  <td className="py-2.5 pl-3.5">
                    <Link
                      href={`/app/services/${s.id}`}
                      className="font-mono text-[12px] text-ink hover:underline"
                    >
                      {s.name}
                    </Link>
                  </td>
                  <td className="py-2.5">
                    <LayerChip layer={s.layer} />
                  </td>
                  <td className="py-2.5 font-mono text-[11px] text-mid">{s.team}</td>
                  <td className="py-2.5 font-mono text-[11px] text-faint">T{s.tier}</td>
                  <td className="py-2.5 font-mono text-[10.5px] text-faint">{s.runtime}</td>
                  <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">{s.deps.length}</td>
                  <td className="py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className="inline-block h-1.5 w-1.5 rounded-full"
                        style={{ background: slo.color }}
                      />
                      <span className="font-mono text-[10.5px]" style={{ color: slo.color }}>
                        {slo.label}
                      </span>
                    </span>
                  </td>
                  <td className="py-2.5 pr-3.5 text-right">
                    <span
                      className="inline-flex items-center justify-center rounded-[3px] px-1.5 py-px font-mono text-[10.5px]"
                      style={{
                        color: gradeColor[g],
                        background: `color-mix(in srgb, ${gradeColor[g]} 12%, transparent)`,
                      }}
                    >
                      {g}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
