import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  customerCosts,
  econStats,
  featureCosts,
  infraCosts,
  infraTotalMo,
  modelCosts,
} from "@/mock/economics";

function marginOf(rev: number, total: number): { label: string; tone: string } {
  if (rev === 0) return { label: "—", tone: "var(--color-err)" };
  const m = ((rev - total) / rev) * 100;
  return {
    label: `${m.toFixed(0)}%`,
    tone: m < 20 ? "var(--color-err)" : m < 55 ? "var(--color-warn)" : "var(--color-ok)",
  };
}

export default function CostsPage() {
  const aiTotal = 2232;
  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Costs</h1>
        <span className="font-mono text-[11px] text-faint">
          one COGS view: tokens (traces) + infrastructure (pods & nodes), joined to customers
        </span>
      </div>
      <p className="mb-4 text-[12.5px] text-mid">
        The full cost of serving — AI and infrastructure consolidated, allocated per customer by the
        traffic they actually generated.
      </p>

      {/* stat row */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
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

      {/* composition bar */}
      <div className="mb-4 rounded-lg border border-line bg-surface px-3.5 py-3">
        <div className="flex h-2.5 overflow-hidden rounded-full">
          <div
            className="h-full"
            style={{ width: `${(aiTotal / (aiTotal + infraTotalMo)) * 100}%`, background: "var(--color-llm)" }}
            title={`AI · $${aiTotal}`}
          />
          <div
            className="h-full"
            style={{ width: `${(infraTotalMo / (aiTotal + infraTotalMo)) * 100}%`, background: "var(--color-infra)" }}
            title={`infrastructure · $${infraTotalMo}`}
          />
        </div>
        <div className="mt-1.5 flex items-center gap-4 font-mono text-[10.5px] text-mid">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: "var(--color-llm)" }} />
            AI (tokens) · ${aiTotal.toLocaleString()}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: "var(--color-infra)" }} />
            infrastructure · ${infraTotalMo}
          </span>
          <span className="ml-auto text-faint">30d</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        {/* cost per customer */}
        <section className="min-w-0 rounded-lg border border-line bg-surface" data-tour="costs">
          <div className="border-b border-line px-3.5 py-2.5">
            <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
              all-in cost per customer · 30d
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                  <th className="py-2 pl-3.5 font-medium">customer</th>
                  <th className="py-2 text-right font-medium">revenue</th>
                  <th className="py-2 text-right font-medium" style={{ color: "var(--color-llm)" }}>ai</th>
                  <th className="py-2 text-right font-medium" style={{ color: "var(--color-infra)" }}>infra</th>
                  <th className="py-2 text-right font-medium">total cogs</th>
                  <th className="py-2 text-right font-medium">margin</th>
                  <th className="py-2 pr-3.5 text-right font-medium">trend</th>
                </tr>
              </thead>
              <tbody>
                {customerCosts.map((c) => {
                  const total = c.llmCostMo + c.infraCostMo;
                  const m = marginOf(c.revenueMo, total);
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
                      <td className="py-2.5 text-right font-mono text-[12px] text-mid">
                        ${c.llmCostMo.toFixed(2)}
                      </td>
                      <td className="py-2.5 text-right font-mono text-[12px] text-mid">
                        ${c.infraCostMo.toFixed(2)}
                      </td>
                      <td className="py-2.5 text-right font-mono text-[12px] text-ink">
                        ${total.toFixed(2)}
                      </td>
                      <td className="py-2.5 text-right font-mono text-[12px]" style={{ color: m.tone }}>
                        {m.label}
                      </td>
                      <td
                        className="py-2.5 pr-3.5 text-right font-mono text-[11.5px]"
                        style={{ color: c.trendPct > 20 ? "var(--color-warn)" : "var(--color-mid)" }}
                      >
                        {c.trendPct > 0 ? "+" : ""}
                        {c.trendPct}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-line px-3.5 py-2 font-mono text-[10px] leading-relaxed text-faint">
            infra allocated by request-volume share of cluster cost (these 5 workspaces ≈ 44% of
            traffic). Atlas Support&apos;s margin is 8% — a heavy Pro workspace priced like a light
            one. Revenue via your Stripe connection.
          </p>
        </section>

        {/* breakdowns */}
        <div className="min-w-0 space-y-4">
          <section className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3.5 py-2.5">
              <h2 className="font-mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-infra)" }}>
                infrastructure · ${infraTotalMo}/mo
              </h2>
            </div>
            <div className="space-y-2.5 px-3.5 py-3">
              {infraCosts.map((i) => (
                <div key={i.name}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="font-mono text-[12px] text-ink">{i.name}</span>
                    <span className="font-mono text-[11px] text-mid">${i.costMo}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(i.costMo / infraTotalMo) * 100}%`, background: "var(--color-infra)" }}
                    />
                  </div>
                  <p className="mt-0.5 font-mono text-[10px] text-faint">{i.note}</p>
                </div>
              ))}
            </div>
            <p className="border-t border-line px-3.5 py-2 font-mono text-[10px] leading-relaxed text-faint">
              $31/mo of idle CPU reservation already identified in{" "}
              <Link href="/app/infra" className="underline decoration-line underline-offset-2 hover:text-mid">
                Infrastructure → right-sizing
              </Link>
            </p>
          </section>

          <section className="rounded-lg border border-line bg-surface">
            <div className="border-b border-line px-3.5 py-2.5">
              <h2 className="font-mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-llm)" }}>
                ai · cost by agent step
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
                ai · cost by model
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
              optimization ideas:{" "}
              <Link href="/app/evals" className="underline decoration-line underline-offset-2 hover:text-mid">
                Evals → cost recommendations
              </Link>{" "}
              (~$347/mo) ·{" "}
              <Link href="/app/infra" className="underline decoration-line underline-offset-2 hover:text-mid">
                right-sizing
              </Link>{" "}
              (~$31/mo)
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
