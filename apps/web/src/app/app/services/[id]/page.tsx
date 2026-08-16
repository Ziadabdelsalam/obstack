import Link from "next/link";
import { Check, X } from "lucide-react";
import { services, grade } from "@/mock/catalog";
import { deploys } from "@/mock/intelligence";
import { LayerChip } from "@/components/ui/LayerChip";

const gradeColor = {
  A: "var(--color-ok)",
  B: "var(--color-infra)",
  C: "var(--color-warn)",
  D: "var(--color-err)",
} as const;

const scoreRows = [
  { key: "coverage", label: "Telemetry coverage" },
  { key: "alerts", label: "Alerts configured" },
  { key: "runbook", label: "Runbook linked" },
  { key: "slo", label: "SLO defined" },
] as const;

export default async function ServiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const service = services.find((s) => s.id === id);

  if (!service) {
    return (
      <div className="px-5 py-4">
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">Service &ldquo;{id}&rdquo; not found.</p>
          <Link
            href="/app/services"
            className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink"
          >
            ← back to service catalog
          </Link>
        </div>
      </div>
    );
  }

  const g = grade(service);
  const passing = Object.values(service.score).filter(Boolean).length;
  const recentDeploys = deploys.slice(0, 3);

  return (
    <div className="px-5 py-4">
      {/* header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h1 className="font-display text-[19px] font-semibold text-ink">{service.name}</h1>
          <LayerChip layer={service.layer} />
          <span
            className="inline-flex items-center justify-center rounded-[3px] px-1.5 py-px font-mono text-[10.5px]"
            style={{
              color: gradeColor[g],
              background: `color-mix(in srgb, ${gradeColor[g]} 12%, transparent)`,
            }}
          >
            {g}
          </span>
        </div>
        <span className="font-mono text-[11px] text-faint">
          {service.team} · T{service.tier} · {service.runtime}
        </span>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* scorecard */}
        <section className="rounded-lg border border-line bg-surface p-3.5">
          <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            Scorecard
          </h2>
          <div className="space-y-1.5">
            {scoreRows.map((row) => {
              const ok = service.score[row.key];
              return (
                <div key={row.key} className="flex items-center justify-between">
                  <span className="text-[12.5px] text-mid">{row.label}</span>
                  {ok ? (
                    <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
                  ) : (
                    <X className="h-3.5 w-3.5" style={{ color: "var(--color-err)" }} />
                  )}
                </div>
              );
            })}
          </div>
          <p className="mt-2.5 border-t border-line pt-2 font-mono text-[10.5px] text-faint">
            {passing}/4 checks passing
          </p>
        </section>

        {/* dependencies */}
        <section className="rounded-lg border border-line bg-surface p-3.5">
          <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            Dependencies
          </h2>
          {service.deps.length === 0 ? (
            <p className="font-mono text-[11.5px] text-faint">no declared dependencies</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {service.deps.map((dep) => {
                const exists = services.some((s) => s.id === dep);
                const chip = (
                  <span className="inline-flex items-center rounded-[3px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-mid">
                    {dep}
                  </span>
                );
                return exists ? (
                  <Link key={dep} href={`/app/services/${dep}`} className="hover:opacity-80">
                    {chip}
                  </Link>
                ) : (
                  <span key={dep}>{chip}</span>
                );
              })}
            </div>
          )}
          <Link
            href="/app/map"
            className="mt-3 inline-block font-mono text-[10.5px] text-faint hover:text-ink"
          >
            View on map →
          </Link>
        </section>

        {/* recent deploys */}
        <section className="rounded-lg border border-line bg-surface p-3.5 xl:col-span-2">
          <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            Recent deploys
          </h2>
          <div className="space-y-1.5">
            {recentDeploys.map((d) => (
              <div key={d.sha} className="flex items-center gap-3 font-mono text-[11.5px]">
                <span className="text-ink">{d.sha}</span>
                <span className="text-faint">{d.time}</span>
                <span className="text-mid">{d.author}</span>
                {d.regression && (
                  <span className="ml-auto" style={{ color: "var(--color-err)" }}>
                    regression
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* links */}
        <section className="rounded-lg border border-line bg-surface p-3.5 xl:col-span-2">
          <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            Links
          </h2>
          <div className="flex flex-wrap gap-4 font-mono text-[11.5px]">
            <Link href="/app/slos" className="hover:underline" style={{ color: "var(--color-api)" }}>
              SLOs
            </Link>
            <Link href="/app/incidents" className="hover:underline" style={{ color: "var(--color-api)" }}>
              Incidents
            </Link>
            <Link href="/app/traces" className="hover:underline" style={{ color: "var(--color-api)" }}>
              Traces
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
