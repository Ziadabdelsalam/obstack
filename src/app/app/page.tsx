import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { statCards, timeseries, topFailing } from "@/mock/metrics";
import { LatencyChart, RequestsChart, TokensChart } from "@/components/dash/Charts";
import { WatchWidgets } from "@/components/dash/WatchWidgets";
import { OnboardingChecklist } from "@/components/dash/OnboardingChecklist";
import { LayerChip } from "@/components/ui/LayerChip";
import type { Layer } from "@/mock/types";

function Card({
  title,
  href,
  hrefLabel,
  children,
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">{title}</h2>
        {href && (
          <Link
            href={href}
            className="flex items-center gap-0.5 font-mono text-[10.5px] text-faint hover:text-ink"
          >
            {hrefLabel ?? "view traces"} <ArrowUpRight className="h-3 w-3" />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

export default function OverviewPage() {
  const data = timeseries();
  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Overview</h1>
        <span className="flex items-center gap-2 font-mono text-[11px] text-faint">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-ok)" }} />
          ingesting · loopwork-prod · last 6h
        </span>
      </div>

      <OnboardingChecklist />

      {/* stat row */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {statCards.map((s) => (
          <div key={s.label} className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{s.label}</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-[22px] font-medium text-ink">{s.value}</span>
              <span
                className="font-mono text-[11px]"
                style={{ color: s.good ? "var(--color-ok)" : "var(--color-warn)" }}
              >
                {s.delta}
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="requests & errors" href="/app/traces?status=error" hrefLabel="view errors">
          <RequestsChart data={data} />
        </Card>
        <Card title="latency" href="/app/traces?minMs=5000" hrefLabel="view slow traces">
          <LatencyChart data={data} />
        </Card>
        <Card title="token spend" href="/app/traces">
          <TokensChart data={data} />
        </Card>
        <Card title="top failing operations" href="/app/traces?status=error" hrefLabel="view errors">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                <th className="pb-1.5 font-medium">operation</th>
                <th className="pb-1.5 font-medium">layer</th>
                <th className="pb-1.5 text-right font-medium">errors · 6h</th>
                <th className="pb-1.5 text-right font-medium">error rate</th>
              </tr>
            </thead>
            <tbody>
              {topFailing.map((f) => (
                <tr key={f.name} className="border-b border-line/50 last:border-0">
                  <td className="py-[7px]">
                    <Link
                      href={`/app/traces?q=${encodeURIComponent(f.name.split(" ").pop() ?? f.name)}&status=error`}
                      className="font-mono text-[12px] text-mid hover:text-ink"
                    >
                      {f.name}
                    </Link>
                  </td>
                  <td className="py-[7px]">
                    <LayerChip layer={f.layer as Layer} />
                  </td>
                  <td className="py-[7px] text-right font-mono text-[12px] text-ink">{f.errors}</td>
                  <td
                    className="py-[7px] text-right font-mono text-[12px]"
                    style={{
                      color: parseFloat(f.rate) > 5 ? "var(--color-err)" : "var(--color-mid)",
                    }}
                  >
                    {f.rate}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <WatchWidgets />
    </div>
  );
}
