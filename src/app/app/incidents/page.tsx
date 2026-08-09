import Link from "next/link";
import { ArrowUpRight, Bot, Boxes, BellRing, ListTree, Activity, Wrench, CheckCircle2, Workflow } from "lucide-react";
import { incidents, type TimelineKind } from "@/mock/incident";
import { IncidentRca } from "@/components/incidents/IncidentRca";

const kindStyle: Record<TimelineKind, { icon: typeof Bot; color: string; label: string }> = {
  pipeline: { icon: Workflow, color: "var(--color-api)", label: "pipeline" },
  trace: { icon: ListTree, color: "var(--color-llm)", label: "traces" },
  alert: { icon: BellRing, color: "var(--color-warn)", label: "alert" },
  metric: { icon: Activity, color: "var(--color-mid)", label: "metric" },
  k8s: { icon: Boxes, color: "var(--color-infra)", label: "k8s" },
  action: { icon: Wrench, color: "var(--color-agent)", label: "operator" },
  resolved: { icon: CheckCircle2, color: "var(--color-ok)", label: "resolved" },
};

export default function IncidentsPage() {
  const inc = incidents[0];
  return (
    <div className="mx-auto max-w-3xl px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Incidents</h1>
        <span className="font-mono text-[11px] text-faint">1 in the last 7 days</span>
      </div>

      <section className="rounded-lg border border-line bg-surface">
        {/* header */}
        <div className="border-b border-line px-4 py-3.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="font-mono text-[12px] text-faint">{inc.id}</span>
            <span
              className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
              style={{
                color: "var(--color-ok)",
                background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
              }}
            >
              RESOLVED
            </span>
            <span className="font-mono text-[11px] text-faint">
              {inc.started} → {inc.ended} · {inc.duration}
            </span>
          </div>
          <h2 className="mt-1.5 text-[16px] font-semibold text-ink">{inc.title}</h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-mid">{inc.summary}</p>
          <p
            className="mt-2.5 rounded-md border px-3 py-2 font-mono text-[11.5px] leading-relaxed"
            style={{
              color: "var(--color-warn)",
              borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
              background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
            }}
          >
            impact · {inc.impact}
          </p>
          <IncidentRca incident={inc} />
        </div>

        {/* timeline */}
        <div className="px-4 py-4">
          <div className="relative ml-2 border-l border-line-strong pl-6">
            {inc.timeline.map((e, i) => {
              const s = kindStyle[e.kind];
              const Icon = s.icon;
              return (
                <div key={i} className="relative pb-5 last:pb-0">
                  <span
                    className="absolute -left-[35px] flex h-[18px] w-[18px] items-center justify-center rounded-full border bg-surface"
                    style={{ borderColor: s.color }}
                  >
                    <Icon className="h-2.5 w-2.5" style={{ color: s.color }} />
                  </span>
                  <div className="flex flex-wrap items-baseline gap-x-2.5">
                    <span className="font-mono text-[11px] text-faint">{e.at}</span>
                    <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: s.color }}>
                      {s.label}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[13.5px] font-medium text-ink">{e.title}</p>
                  {e.detail && (
                    <p className="mt-0.5 text-[12.5px] leading-relaxed text-mid">{e.detail}</p>
                  )}
                  {e.link && (
                    <Link
                      href={e.link.href}
                      className="mt-1 inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                      style={{ color: "var(--color-api)" }}
                    >
                      {e.link.label} <ArrowUpRight className="h-3 w-3" />
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <p className="mt-3 font-mono text-[10.5px] leading-relaxed text-faint">
        reconstructed automatically from pipelines, alerts, k8s events, metrics and traces sharing
        the incident window — the timeline is the same data you&apos;ve seen on every other screen,
        stitched.
      </p>
    </div>
  );
}
