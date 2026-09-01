import Link from "next/link";
import { fmtCost, fmtMs } from "@/lib/format";
import { fmtPerMin, SERVICE_CAP, WINDOW_HOURS, type ServiceList } from "@/lib/services-types";
import { LayerChip } from "@/components/ui/LayerChip";

/**
 * The service catalog, live (D367): a SERVER component (D392 — selection here
 * is a `<Link>`, so there is no interactivity to ship JS for), fed exclusively
 * by `server/queries/services.ts` through `services/page.tsx`. No `@/mock/`
 * import anywhere in this file (A2) — the fixture catalog's team, tier,
 * runtime, SLO status, scorecard and grade have no trace-derived counterpart,
 * so they are absent rather than zeroed (D13).
 *
 * `deps` is absent for a different reason (D393): the dependency answer is the
 * service map's, derived once from the same spans, so the column links there
 * instead of restating a count this surface cannot derive.
 *
 * Every number on this page is stated with its basis (D13/D389): one fixed
 * window, named in the header; the rate's divisor and the error percentage's
 * definition in the column headers; the cap's ranking in the banner.
 */
export function ServicesLive({ list }: { list: ServiceList }) {
  const { rows, totalServices } = list;

  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Service catalog</h1>
        <span className="font-mono text-[11px] text-faint">
          {totalServices} {totalServices === 1 ? "service" : "services"} · last {WINDOW_HOURS}h
        </span>
      </div>
      <p className="mb-4 font-mono text-[10.5px] text-faint">
        every service that sent a span in the last {WINDOW_HOURS}h, scored from those spans —
        error rate, latency and cost. Nothing here is configured.
      </p>

      {rows.length === 0 ? (
        <section className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">
            no service has sent a span in the last {WINDOW_HOURS}h
          </p>
          <Link
            href="/app/onboarding"
            className="mt-3 inline-block font-mono text-[12px] text-faint hover:text-ink"
          >
            connect a source →
          </Link>
        </section>
      ) : (
        <section className="min-w-0 overflow-x-auto rounded-lg border border-line bg-surface">
          {/* D402: the truncation statement and the truncated rows are one
              answer — rendered only when the cap actually cut something. */}
          {totalServices > SERVICE_CAP && (
            <p className="border-b border-line px-3.5 py-2 font-mono text-[10.5px] text-faint">
              showing {SERVICE_CAP} of {totalServices} services by span volume
            </p>
          )}
          <table className="w-full min-w-[980px] border-collapse">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
                <th className="py-2 pl-3.5 font-medium">service</th>
                <th className="py-2 font-medium">layer</th>
                <th className="py-2 text-right font-medium">spans</th>
                <th className="py-2 text-right font-medium">spans/min</th>
                <th className="py-2 text-right font-medium">error %</th>
                <th className="py-2 text-right font-medium">p50</th>
                <th className="py-2 text-right font-medium">p95</th>
                <th className="py-2 text-right font-medium">cost</th>
                <th className="py-2 font-medium">models</th>
                <th className="py-2 font-medium">dependencies</th>
                <th className="py-2 pr-3.5 font-medium">last span</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.name} className="border-b border-line/50 last:border-0">
                  <td className="py-2.5 pl-3.5">
                    <Link
                      href={`/app/services/${encodeURIComponent(s.name)}`}
                      className="font-mono text-[12px] text-ink hover:underline"
                    >
                      {s.name}
                    </Link>
                  </td>
                  <td className="py-2.5">
                    <LayerChip layer={s.layer} />
                  </td>
                  <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">
                    {s.spans.toLocaleString("en-US")}
                  </td>
                  <td className="py-2.5 text-right font-mono text-[11.5px] text-faint">
                    {fmtPerMin(s.spansPerMin)}
                  </td>
                  <td
                    className="py-2.5 text-right font-mono text-[11.5px]"
                    style={{ color: s.errorPct > 0 ? "var(--color-err)" : "var(--color-faint)" }}
                  >
                    {s.errorPct.toFixed(1)}%
                  </td>
                  <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">{fmtMs(s.p50Ms)}</td>
                  <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">{fmtMs(s.p95Ms)}</td>
                  <td className="py-2.5 text-right font-mono text-[11.5px] text-mid">{fmtCost(s.costUsd)}</td>
                  <td className="py-2.5 font-mono text-[10.5px] text-faint">
                    {s.models.length === 0 ? "—" : s.models.join(", ")}
                  </td>
                  <td className="py-2.5">
                    <Link href="/app/map" className="font-mono text-[10.5px] text-faint hover:text-ink">
                      map →
                    </Link>
                  </td>
                  <td className="py-2.5 pr-3.5 font-mono text-[10.5px] text-faint">{s.lastSeenAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <p className="mt-2.5 font-mono text-[10.5px] text-faint">
        spans/min = spans ÷ {WINDOW_HOURS * 60} minutes · error % = error spans ÷ spans ·
        p50/p95 over span duration · last span in UTC
      </p>
    </div>
  );
}
