import Link from "next/link";
import { fmtCost, fmtTokens } from "@/lib/format";
import { COSTS_GROUP_CAP, COSTS_RANGES, type CostsRange, type CostsReport } from "@/lib/costs-types";

/** D472: the label every sentence on this page uses for its range. */
const RANGE_LABEL: Record<CostsRange, string> = {
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

/** D472: the chart heading's bucket noun for each range. */
const BUCKET_LABEL: Record<CostsRange, string> = {
  "24h": "hour",
  "7d": "6 hours",
  "30d": "day",
};

/** D472, frozen — always true, regardless of range: both edge bars are partial. */
const CHART_FOOTNOTE =
  "The first and last bars are partial — they cover the window's edges — so the bars sum to the total above.";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{label}</p>
      <p className="mt-1 font-mono text-[20px] font-medium text-ink">{value}</p>
    </div>
  );
}

/**
 * Spend over time, rendered as plain CSS bars rather than recharts: the
 * page-level requirement is a server component (D392 — there is no
 * selection or filtering here, so nothing needs client JS), and every
 * `report.series` bucket is rendered as given — the grid's length is
 * clock-dependent (D472) and this never assumes a count.
 */
function SpendBars({ series }: { series: CostsReport["series"] }) {
  const maxCost = Math.max(0, ...series.map((p) => p.costUsd));
  return (
    <div className="flex h-28 items-end gap-px" role="img" aria-label="spend over time">
      {series.map((p) => (
        <div
          key={p.t}
          className="flex-1 rounded-t-sm"
          style={{
            height: maxCost > 0 ? `${Math.max((p.costUsd / maxCost) * 100, p.costUsd > 0 ? 2 : 0)}%` : "0%",
            background: "var(--color-llm)",
          }}
          title={`${p.t} · ${fmtCost(p.costUsd)} · ${p.calls} calls`}
        />
      ))}
    </div>
  );
}

/**
 * Costs, live (D367): trace-derived LLM unit economics, fed exclusively by
 * `server/queries/costs.ts` through `costs/page.tsx`. No `@/mock/` import
 * anywhere in this file (A2) — everything the mock page showed that has no
 * trace-derived counterpart (per-customer revenue/margin, infra $, per-feature
 * spend, forecasts) is ABSENT here rather than zeroed (D362/D13): none of it
 * has a field on `CostsReport` at all, so none of it can be rendered.
 *
 * D461: pricing happens at ingest, so a model with no price row lands in
 * `cost_usd` as 0 — indistinguishable from a call that was genuinely free.
 * Every figure below that could be that silent zero is named "unpriced"
 * instead of shown as `$0.00`: `fmtCost` itself renders an exact 0 as "—",
 * which is the wanted output for a fully-unpriced cost cell; the stat card,
 * the by-model cost cell and the closing sentence all read
 * `unpricedCalls`/`unpricedModels` so the honesty is never silent.
 */
export function CostsLive({ report }: { report: CostsReport }) {
  const { totals, range } = report;
  const rangeLabel = RANGE_LABEL[range];

  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Costs</h1>
        <nav className="flex items-center gap-3 font-mono text-[11px] text-faint" aria-label="range">
          {COSTS_RANGES.map((r) => (
            <Link
              key={r}
              href={`/app/costs?range=${r}`}
              aria-current={r === range ? "page" : undefined}
              className={r === range ? "text-ink" : "hover:text-mid"}
            >
              {RANGE_LABEL[r]}
            </Link>
          ))}
        </nav>
      </div>
      <p className="mb-4 text-[12.5px] text-mid">
        Trace-derived LLM spend, priced at ingest from the model and token counts on every LLM
        span this workspace sent.
      </p>

      {totals.calls === 0 ? (
        <p className="rounded-lg border border-line bg-surface px-3.5 py-6 text-center font-mono text-[12.5px] text-mid">
          {`No LLM calls in this workspace's traces in the last ${rangeLabel}.`}
        </p>
      ) : (
        <>
          {/* stat row */}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label={`LLM cost · last ${rangeLabel}`} value={fmtCost(totals.costUsd)} />
            <Stat label="calls" value={totals.calls.toLocaleString("en-US")} />
            <Stat label="tokens in" value={fmtTokens(totals.inputTokens)} />
            <Stat label="tokens out" value={fmtTokens(totals.outputTokens)} />
            <Stat label="unpriced calls" value={totals.unpricedCalls.toLocaleString("en-US")} />
          </div>

          {/* spend over time */}
          <section className="mb-4 rounded-lg border border-line bg-surface px-3.5 py-3">
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-widest text-faint">
              {`Spend per ${BUCKET_LABEL[range]} · last ${rangeLabel}`}
            </h2>
            <SpendBars series={report.series} />
            <p className="mt-2 font-mono text-[10px] text-faint">{CHART_FOOTNOTE}</p>
          </section>

          <div className="grid gap-4 xl:grid-cols-2">
            {/* by model */}
            <section className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface" data-tour="costs">
              <div className="border-b border-line px-3.5 py-2.5">
                <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">cost by model</h2>
              </div>
              {report.totalModels > report.byModel.length && (
                <p className="border-b border-line px-3.5 py-2 font-mono text-[10.5px] text-faint">
                  {`showing ${COSTS_GROUP_CAP} of ${report.totalModels} models`}
                </p>
              )}
              <table className="w-full min-w-[560px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                    <th className="py-2 pl-3.5 font-medium">model</th>
                    <th className="py-2 font-medium">system</th>
                    <th className="py-2 text-right font-medium">cost</th>
                    <th className="py-2 text-right font-medium">calls</th>
                    <th className="py-2 text-right font-medium">tokens in</th>
                    <th className="py-2 pr-3.5 text-right font-medium">tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byModel.map((m) => {
                    const costCell =
                      m.unpricedCalls === m.calls
                        ? "—"
                        : m.unpricedCalls > 0
                          ? `${fmtCost(m.costUsd)} (${m.unpricedCalls} unpriced)`
                          : fmtCost(m.costUsd);
                    return (
                      <tr key={m.model} className="border-b border-line/50 last:border-0">
                        <td className="py-2.5 pl-3.5 font-mono text-[12px] text-ink">
                          {m.model === "" ? "unknown" : m.model}
                        </td>
                        <td className="py-2.5 font-mono text-[11.5px] text-faint">{m.system}</td>
                        <td className="py-2.5 text-right font-mono text-[12px] text-mid">{costCell}</td>
                        <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">
                          {m.calls.toLocaleString("en-US")}
                        </td>
                        <td className="py-2.5 text-right font-mono text-[11.5px] text-faint">
                          {fmtTokens(m.inputTokens)}
                        </td>
                        <td className="py-2.5 pr-3.5 text-right font-mono text-[11.5px] text-faint">
                          {fmtTokens(m.outputTokens)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>

            {/* by service */}
            <section className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
              <div className="border-b border-line px-3.5 py-2.5">
                <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">cost by service</h2>
              </div>
              {report.totalServices > report.byService.length && (
                <p className="border-b border-line px-3.5 py-2 font-mono text-[10.5px] text-faint">
                  {`showing ${COSTS_GROUP_CAP} of ${report.totalServices} services`}
                </p>
              )}
              <table className="w-full min-w-[420px] border-collapse">
                <thead>
                  <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                    <th className="py-2 pl-3.5 font-medium">service</th>
                    <th className="py-2 text-right font-medium">cost</th>
                    <th className="py-2 text-right font-medium">calls</th>
                    <th className="py-2 pr-3.5 text-right font-medium">models</th>
                  </tr>
                </thead>
                <tbody>
                  {report.byService.map((s) => (
                    <tr key={s.service} className="border-b border-line/50 last:border-0">
                      <td className="py-2.5 pl-3.5 font-mono text-[12px] text-ink">
                        {s.service === "" ? "(no service)" : s.service}
                      </td>
                      <td className="py-2.5 text-right font-mono text-[12px] text-mid">{fmtCost(s.costUsd)}</td>
                      <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">
                        {s.calls.toLocaleString("en-US")}
                      </td>
                      <td className="py-2.5 pr-3.5 text-right font-mono text-[11.5px] text-faint">
                        {s.modelCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {totals.unpricedCalls > 0 && (
            <section className="mt-4 rounded-lg border border-line bg-surface">
              <div className="border-b border-line px-3.5 py-2.5">
                <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">unpriced calls</h2>
              </div>
              <p className="px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-faint">
                {`${totals.unpricedCalls} calls across ${report.totalUnpricedModels} models carry no price row, so their cost is unknown — not $0.`}{" "}
                <Link
                  href="/app/docs/what-obstack-does-not-do"
                  className="underline decoration-line underline-offset-2 hover:text-mid"
                >
                  why
                </Link>
              </p>
              {report.totalUnpricedModels > report.unpricedModels.length && (
                <p className="border-t border-line px-3.5 py-2 font-mono text-[10.5px] text-faint">
                  {`showing ${COSTS_GROUP_CAP} of ${report.totalUnpricedModels} unpriced models`}
                </p>
              )}
              <table className="w-full min-w-[320px] border-collapse">
                <thead>
                  <tr className="border-b border-t border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                    <th className="py-2 pl-3.5 font-medium">model</th>
                    <th className="py-2 text-right font-medium">calls</th>
                    <th className="py-2 pr-3.5 text-right font-medium">cost</th>
                  </tr>
                </thead>
                <tbody>
                  {report.unpricedModels.map((u) => (
                    <tr key={u.model} className="border-b border-line/50 last:border-0">
                      <td className="py-2.5 pl-3.5 font-mono text-[12px] text-ink">
                        {u.model === "" ? "unknown" : u.model}
                      </td>
                      <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">
                        {u.calls.toLocaleString("en-US")}
                      </td>
                      <td className="py-2.5 pr-3.5 text-right font-mono text-[11.5px] text-faint">—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  );
}
