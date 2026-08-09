import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { customerCosts, econStats, featureCosts, modelCosts } from "@/mock/economics";

function marginPct(rev: number, cost: number): { label: string; tone: string } {
  if (rev === 0) return { label: "—", tone: "var(--color-err)" };
  const m = ((rev - cost) / rev) * 100;
  return {
    label: `${m.toFixed(0)}%`,
    tone: m < 60 ? "var(--color-warn)" : "var(--color-ok)",
  };
}

export default function CostsPage() {
  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Costs</h1>
        <span className="font-mono text-[11px] text-faint">
          computed at ingest: tokens × model pricing, joined to traces & customers
        </span>
      </div>
      <p className="mb-4 text-[12.5px] text-mid">
        The unit economics of your AI features — cost per customer, per feature, per model.
      </p>

      {/* stat row */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {econStats.map((s) => (
          <div key={s.label} className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{s.label}</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-[20px] font-medium text-ink">{s.value}</span>
              <span
                className="font-mono text-[10.5px]"
                style={{ color: s.good ? "var(--color-ok)" : "var(--color-warn)" }}
              >
                {s.delta}
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* cost per customer */}
        <section className="min-w-0 rounded-lg border border-line bg-surface" data-tour="costs">
          <div className="border-b border-line px-3.5 py-2.5">
            <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
              cost per customer · 30d
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                  <th className="py-2 pl-3.5 font-medium">customer</th>
                  <th className="py-2 text-right font-medium">revenue/mo</th>
                  <th className="py-2 text-right font-medium">llm cost/mo</th>
                  <th className="py-2 text-right font-medium">margin</th>
                  <th className="py-2 text-right font-medium">cost trend</th>
                  <th className="py-2 pr-3.5 text-right font-medium">traces</th>
                </tr>
              </thead>
              <tbody>
                {customerCosts.map((c) => {
                  const m = marginPct(c.revenueMo, c.llmCostMo);
                  return (
                    <tr key={c.org} className="border-b border-line/50 last:border-0">
                      <td className="py-2.5 pl-3.5">
                        <span className="block text-[13px] text-ink">{c.org}</span>
                        <span className="font-mono text-[10px] text-faint">
                          {c.plan} · {c.reqs30d.toLocaleString()} reqs
                        </span>
                      </td>
                      <td className="py-2.5 text-right font-mono text-[12px] text-mid">
                        {c.revenueMo ? `$${c.revenueMo}` : "$0"}
                      </td>
                      <td className="py-2.5 text-right font-mono text-[12px] text-ink">
                        ${c.llmCostMo.toFixed(2)}
                      </td>
                      <td className="py-2.5 text-right font-mono text-[12px]" style={{ color: m.tone }}>
                        {m.label}
                      </td>
                      <td
                        className="py-2.5 text-right font-mono text-[11.5px]"
                        style={{ color: c.trendPct > 20 ? "var(--color-warn)" : "var(--color-mid)" }}
                      >
                        {c.trendPct > 0 ? "+" : ""}
                        {c.trendPct}%
                      </td>
                      <td className="py-2.5 pr-3.5 text-right">
                        <Link
                          href="/app/traces"
                          className="inline-flex items-center gap-0.5 font-mono text-[10.5px] hover:underline"
                          style={{ color: "var(--color-api)" }}
                        >
                          view <ArrowUpRight className="h-2.5 w-2.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-3.5 py-2 font-mono text-[10px] leading-relaxed text-faint">
            Brightline AI (free tier) costs $6.80/mo and is growing 58% — a conversion candidate, or
            a cap candidate. Revenue figures come from your billing connection (Stripe).
          </p>
        </section>

        {/* by feature + model */}
        <div className="min-w-0 space-y-4">
          <section className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3.5 py-2.5">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
                cost by agent step · 30d
              </h2>
            </div>
            <div className="space-y-2.5 px-3.5 py-3">
              {featureCosts.map((f) => (
                <div key={f.name}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="font-mono text-[12px] text-ink">{f.name}</span>
                    <span className="font-mono text-[11px] text-mid">
                      ${f.costMo} · {f.sharePct}%
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${f.sharePct}%`, background: "var(--color-llm)" }}
                    />
                  </div>
                  {f.note && <p className="mt-0.5 font-mono text-[10px] text-faint">{f.note}</p>}
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3.5 py-2.5">
              <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
                cost by model · 30d
              </h2>
            </div>
            <div className="space-y-2.5 px-3.5 py-3">
              {modelCosts.map((m) => (
                <div key={m.model}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="font-mono text-[12px] text-ink">{m.model}</span>
                    <span className="font-mono text-[11px] text-mid">
                      ${m.costMo} · {m.sharePct}%
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${m.sharePct}%`, background: "var(--color-api)" }}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="border-t border-line px-3.5 py-2 font-mono text-[10px] leading-relaxed text-faint">
              optimization ideas live in{" "}
              <Link href="/app/evals" className="underline decoration-line underline-offset-2 hover:text-mid">
                Evals → cost recommendations
              </Link>{" "}
              (~$347/mo identified)
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
