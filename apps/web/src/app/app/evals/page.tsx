import { AlertTriangle, TrendingDown, TrendingUp } from "lucide-react";
import { costRecs, deploys } from "@/mock/intelligence";

export default function EvalsPage() {
  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center gap-2">
        <h1 className="font-display text-[19px] font-semibold text-ink">Evals</h1>
        <span
          className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
          style={{
            color: "var(--color-llm)",
            background: "color-mix(in srgb, var(--color-llm) 12%, transparent)",
          }}
        >
          AI ASSIST
        </span>
      </div>
      <p className="mb-4 text-[12.5px] text-mid">
        Production evals on live traces — every deploy is scored against the traffic it actually served.
      </p>

      {/* stat row */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "review confidence · 24h", value: "0.91", delta: "+0.01", good: true },
          { label: "regressions · 7d", value: "1", delta: "b81de07", good: false },
          { label: "cost / request · 24h", value: "$0.019", delta: "−9%", good: true },
          { label: "replay coverage", value: "82%", delta: "4.1k traces", good: true },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-line bg-surface px-3.5 py-3">
            <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{s.label}</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-[22px] font-medium text-ink">{s.value}</span>
              <span
                className="font-mono text-[11px]"
                style={{ color: s.good ? "var(--color-ok)" : "var(--color-err)" }}
              >
                {s.delta}
              </span>
            </p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
        {/* deploys */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            deploys · scored on production traffic
          </h2>
          <div className="space-y-2">
            {deploys.map((d) => {
              const confDelta = +(d.confidenceAfter - d.confidenceBefore).toFixed(2);
              const costDelta = +(d.costPerReqAfter - d.costPerReqBefore).toFixed(3);
              return (
                <div
                  key={d.sha}
                  className="rounded-lg border bg-surface p-3.5"
                  style={{
                    borderColor: d.regression
                      ? "color-mix(in srgb, var(--color-err) 40%, var(--color-line))"
                      : "var(--color-line)",
                  }}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[12px] text-ink">{d.sha}</span>
                    <span className="font-mono text-[10.5px] text-faint">
                      {d.time} · by {d.author}
                    </span>
                    {d.regression && (
                      <span
                        className="ml-auto flex items-center gap-1 rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                        style={{
                          color: "var(--color-err)",
                          background: "color-mix(in srgb, var(--color-err) 12%, transparent)",
                        }}
                      >
                        <AlertTriangle className="h-3 w-3" /> REGRESSION
                      </span>
                    )}
                  </div>
                  {d.note && <p className="mt-1 text-[12.5px] text-mid">{d.note}</p>}
                  <div className="mt-2.5 flex flex-wrap gap-x-6 gap-y-1">
                    <span className="flex items-center gap-1.5 font-mono text-[11.5px]">
                      <span className="text-faint">confidence</span>
                      <span className="text-mid">
                        {d.confidenceBefore.toFixed(2)} → {d.confidenceAfter.toFixed(2)}
                      </span>
                      {confDelta < 0 ? (
                        <TrendingDown className="h-3.5 w-3.5" style={{ color: "var(--color-err)" }} />
                      ) : (
                        <TrendingUp className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
                      )}
                    </span>
                    <span className="flex items-center gap-1.5 font-mono text-[11.5px]">
                      <span className="text-faint">cost/req</span>
                      <span className="text-mid">
                        ${d.costPerReqBefore.toFixed(3)} → ${d.costPerReqAfter.toFixed(3)}
                      </span>
                      <span
                        style={{
                          color: costDelta > 0 ? "var(--color-warn)" : "var(--color-ok)",
                        }}
                        className="font-mono text-[10.5px]"
                      >
                        {costDelta > 0 ? "+" : ""}
                        {(costDelta * 1000).toFixed(0)}‰
                      </span>
                    </span>
                  </div>
                  {d.regression && (
                    <p className="mt-2 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12px] leading-relaxed text-mid">
                      Review confidence dropped 0.92 → 0.78 on the traffic this deploy served, while
                      cost rose 26%. The classify_intent model swap added latency and context without
                      measurable accuracy gain — recommend revert or A/B against f4a2c91.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* cost recommendations */}
        <section className="min-w-0">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            cost recommendations
          </h2>
          <div className="space-y-2">
            {costRecs.map((r) => (
              <div key={r.title} className="rounded-lg border border-line bg-surface p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-[13px] font-medium text-ink">{r.title}</h3>
                  <span
                    className="shrink-0 rounded-[3px] px-1.5 py-px font-mono text-[10px]"
                    style={{
                      color: "var(--color-ok)",
                      background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
                    }}
                  >
                    {r.savings}
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] leading-relaxed text-mid">{r.detail}</p>
              </div>
            ))}
            <p className="pt-1 font-mono text-[10.5px] text-faint">
              estimated from replayed production traces · savings at current volume
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
