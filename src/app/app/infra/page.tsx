import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { nodes, pods, rightsizing } from "@/mock/infra";

function UtilBar({ pct, hot }: { pct: number; hot?: boolean }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-overlay">
      <div
        className="h-full rounded-full"
        style={{
          width: `${pct}%`,
          background: hot || pct >= 80 ? "var(--color-warn)" : "var(--color-api)",
        }}
      />
    </div>
  );
}

export default function InfraPage() {
  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Infrastructure</h1>
        <span className="font-mono text-[11px] text-faint">
          prod-cluster (GKE) · 4 nodes · {pods.length} pods · synced via obstack-collector
        </span>
      </div>

      {/* nodes */}
      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        {nodes.map((n) => (
          <div
            key={n.name}
            className="rounded-lg border bg-surface p-3.5"
            style={{
              borderColor:
                n.status === "pressure"
                  ? "color-mix(in srgb, var(--color-warn) 40%, var(--color-line))"
                  : "var(--color-line)",
            }}
          >
            <div className="flex items-center justify-between">
              <p className="truncate font-mono text-[12px] text-ink">{n.name}</p>
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: n.status === "ready" ? "var(--color-ok)" : "var(--color-warn)" }}
              />
            </div>
            <p className="mt-0.5 font-mono text-[10px] text-faint">
              {n.pool} · {n.pods} pods
            </p>
            <div className="mt-2.5 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="w-7 font-mono text-[9.5px] text-faint">cpu</span>
                <UtilBar pct={n.cpuPct} />
                <span className="w-8 text-right font-mono text-[10px] text-mid">{n.cpuPct}%</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-7 font-mono text-[9.5px] text-faint">mem</span>
                <UtilBar pct={n.memPct} />
                <span className="w-8 text-right font-mono text-[10px] text-mid">{n.memPct}%</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        {/* pods */}
        <section className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full min-w-[760px] border-collapse">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                <th className="py-2 pl-3.5 font-medium">pod</th>
                <th className="py-2 font-medium">node</th>
                <th className="py-2 text-right font-medium">restarts 24h</th>
                <th className="w-[180px] py-2 pl-6 font-medium">memory</th>
                <th className="py-2 text-right font-medium">cpu</th>
                <th className="py-2 text-right font-medium">age</th>
                <th className="py-2 pr-3.5 text-right font-medium">drill</th>
              </tr>
            </thead>
            <tbody>
              {pods.map((p) => {
                const memPct = Math.round((p.rssMi / p.limitMi) * 100);
                const hot = memPct >= 90 || p.restarts24h >= 3;
                return (
                  <tr key={p.name} className="border-b border-line/50 last:border-0">
                    <td className="py-2.5 pl-3.5">
                      <span className="block truncate font-mono text-[11.5px] text-ink">{p.name}</span>
                      <span className="font-mono text-[9.5px] text-faint">{p.service}</span>
                    </td>
                    <td className="py-2.5 font-mono text-[10px] text-faint">{p.node.replace("gke-prod-", "")}</td>
                    <td
                      className="py-2.5 text-right font-mono text-[11.5px]"
                      style={{ color: p.restarts24h >= 3 ? "var(--color-err)" : p.restarts24h > 0 ? "var(--color-warn)" : "var(--color-mid)" }}
                    >
                      {p.restarts24h}
                    </td>
                    <td className="py-2.5 pl-6">
                      <div className="flex items-center gap-2">
                        <div className="w-[90px]">
                          <UtilBar pct={memPct} hot={hot} />
                        </div>
                        <span className="font-mono text-[10px]" style={{ color: hot ? "var(--color-warn)" : "var(--color-faint)" }}>
                          {p.rssMi}/{p.limitMi}Mi
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 text-right font-mono text-[11px] text-mid">{p.cpuPct}%</td>
                    <td className="py-2.5 text-right font-mono text-[10.5px] text-faint">{p.age}</td>
                    <td className="py-2.5 pr-3.5 text-right">
                      <Link
                        href={`/app/logs?q=${encodeURIComponent(p.name.split("-").slice(0, 2).join("-"))}`}
                        className="inline-flex items-center gap-0.5 font-mono text-[10px] hover:underline"
                        style={{ color: "var(--color-api)" }}
                      >
                        logs <ArrowUpRight className="h-2.5 w-2.5" />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {/* right-sizing */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            right-sizing recommendations
          </h2>
          <div className="space-y-2">
            {rightsizing.map((r) => (
              <div key={r.title} className="rounded-lg border border-line bg-surface p-3.5">
                <h3 className="text-[13px] font-medium text-ink">{r.title}</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-mid">{r.detail}</p>
                <p className="mt-1.5 font-mono text-[10.5px]" style={{ color: "var(--color-ok)" }}>
                  → {r.impact}
                </p>
              </div>
            ))}
            <p className="pt-1 font-mono text-[10px] leading-relaxed text-faint">
              derived from 30d of pod telemetry + the traces those pods served — utilization with
              request-level context
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
