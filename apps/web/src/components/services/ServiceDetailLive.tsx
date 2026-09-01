import Link from "next/link";
import { fmtCost, fmtMs } from "@/lib/format";
import {
  fmtPerMin,
  RECENT_ERROR_TRACE_CAP,
  TOP_SPAN_NAME_CAP,
  WINDOW_HOURS,
  type ServiceDetail,
} from "@/lib/services-types";
import {
  EMPTY_TRACES_FILTERS,
  tracesHref,
  tracesSearchString,
} from "@/lib/traces-filter";
import { LayerChip } from "@/components/ui/LayerChip";
import { SampleMark } from "@/components/ui/SampleMark";

/**
 * One service, live (D367): a SERVER component (D392), fed by
 * `server/queries/services.ts` through `services/[id]/page.tsx`. No `@/mock/`
 * import anywhere in this file (A2/D401) — the deploys the panel below renders
 * arrive as a PROP from the page, which is the one place the fixture is still
 * named, and the panel wears `SampleMark` so nobody reads them as this
 * service's real deploys (D362/D401).
 *
 * Absent, because the spans cannot answer them (D13): the scorecard, the
 * grade, the team/tier/runtime line, and the declared dependency list — the
 * dependency answer is the service map's (D393), linked below.
 */

/**
 * What the deploys panel renders. Structural on purpose: typing this against
 * `Deploy` from `@/mock/intelligence` would put a mock import in this file,
 * which is exactly what D401 forbids — and the panel only ever reads these
 * four fields.
 */
interface DeploySample {
  sha: string;
  time: string;
  author: string;
  regression: boolean;
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{label}</p>
      <p className="mt-0.5 font-mono text-[13px]" style={{ color: color ?? "var(--color-ink)" }}>
        {value}
      </p>
    </div>
  );
}

export function ServiceDetailLive({
  name,
  detail,
  deploys,
}: {
  name: string;
  detail: ServiceDetail | null;
  deploys: DeploySample[];
}) {
  if (!detail) {
    return (
      <div className="px-5 py-4">
        <div className="rounded-lg border border-line bg-surface p-6 text-center">
          <p className="font-mono text-[13px] text-mid">
            No spans from &ldquo;{name}&rdquo; in the last {WINDOW_HOURS}h.
          </p>
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

  const serviceTraces = tracesHref(
    tracesSearchString({ ...EMPTY_TRACES_FILTERS, service: detail.name, range: "24h" }),
  );
  const errorTraces = tracesHref(
    tracesSearchString({
      ...EMPTY_TRACES_FILTERS,
      service: detail.name,
      status: "error",
      range: "24h",
    }),
  );

  return (
    <div className="px-5 py-4">
      {/* header */}
      <div className="mb-1 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h1 className="font-display text-[19px] font-semibold text-ink">{detail.name}</h1>
          <LayerChip layer={detail.layer} />
        </div>
        <span className="font-mono text-[11px] text-faint">
          last {WINDOW_HOURS}h · last span {detail.lastSeenAt}
        </span>
      </div>
      <p className="mb-4 font-mono text-[10.5px] text-faint">
        scored from this service&rsquo;s spans in the last {WINDOW_HOURS}h — error rate, latency
        and cost. Nothing here is configured.
      </p>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* the row, spelled out */}
        <section className="rounded-lg border border-line bg-surface p-3.5 xl:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="spans" value={detail.spans.toLocaleString("en-US")} />
            <Stat label="spans/min" value={fmtPerMin(detail.spansPerMin)} />
            <Stat
              label="error %"
              value={`${detail.errorPct.toFixed(1)}%`}
              color={detail.errorPct > 0 ? "var(--color-err)" : undefined}
            />
            <Stat label="p50" value={fmtMs(detail.p50Ms)} />
            <Stat label="p95" value={fmtMs(detail.p95Ms)} />
            <Stat label="cost" value={fmtCost(detail.costUsd)} />
          </div>
          <p className="mt-2.5 border-t border-line pt-2 font-mono text-[10.5px] text-faint">
            spans/min = spans ÷ {WINDOW_HOURS * 60} minutes · error % = error spans ÷ spans ·
            p50/p95 over span duration ·{" "}
            {detail.models.length === 0
              ? "no gen_ai model on these spans"
              : `models: ${detail.models.join(", ")}`}
          </p>
        </section>

        {/* top span names */}
        <section className="rounded-lg border border-line bg-surface p-3.5">
          <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            Top span names
          </h2>
          {detail.totalSpanNames > TOP_SPAN_NAME_CAP && (
            <p className="mb-2 font-mono text-[10.5px] text-faint">
              showing {TOP_SPAN_NAME_CAP} of {detail.totalSpanNames} span names by count
            </p>
          )}
          <div className="space-y-1.5">
            {detail.topSpanNames.map((row) => (
              <div key={row.name} className="flex items-center gap-3 font-mono text-[11.5px]">
                <span className="min-w-0 flex-1 truncate text-mid">{row.name}</span>
                <span className="text-faint">{row.count.toLocaleString("en-US")}</span>
                <span
                  className="w-12 text-right"
                  style={{ color: row.errorPct > 0 ? "var(--color-err)" : "var(--color-faint)" }}
                >
                  {row.errorPct.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
          <Link
            href={serviceTraces}
            className="mt-3 inline-block font-mono text-[10.5px] text-faint hover:text-ink"
          >
            View this service&rsquo;s traces →
          </Link>
        </section>

        {/* recent error traces */}
        <section className="rounded-lg border border-line bg-surface p-3.5">
          <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            Recent error traces
          </h2>
          {detail.recentErrorTraces.length === 0 ? (
            <p className="font-mono text-[11.5px] text-faint">
              no trace carrying this service ended in an error in the last {WINDOW_HOURS}h
            </p>
          ) : (
            <div className="space-y-1.5">
              {detail.recentErrorTraces.map((t) => (
                <div key={t.traceId} className="flex items-center gap-3 font-mono text-[11.5px]">
                  <Link
                    href={`/app/traces/${t.traceId}`}
                    className="min-w-0 flex-1 truncate text-ink hover:underline"
                  >
                    {t.rootName === "" ? t.traceId : t.rootName}
                  </Link>
                  <span className="text-faint">{t.startedAt}</span>
                </div>
              ))}
            </div>
          )}
          <p className="mt-2.5 border-t border-line pt-2 font-mono text-[10.5px] text-faint">
            up to {RECENT_ERROR_TRACE_CAP} most recent traces this service took part in that carry
            an error span — the error may belong to another service of the same trace.{" "}
            <Link href={errorTraces} className="hover:text-ink">
              All error traces →
            </Link>
          </p>
        </section>

        {/* dependencies — one derivation, and it is the map's (D393) */}
        <section className="rounded-lg border border-line bg-surface p-3.5">
          <h2 className="mb-2.5 font-mono text-[11px] uppercase tracking-widest text-faint">
            Dependencies
          </h2>
          <p className="font-mono text-[11.5px] text-faint">
            what this service calls is derived from parent/child spans across services, on the
            service map.
          </p>
          <Link
            href="/app/map"
            className="mt-3 inline-block font-mono text-[10.5px] text-faint hover:text-ink"
          >
            View on map →
          </Link>
        </section>

        {/* recent deploys — D362/D401: rendered, and marked for what it is */}
        <section className="rounded-lg border border-line bg-surface p-3.5">
          <h2 className="mb-2.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-faint">
            Recent deploys
            <SampleMark title="sample data — deploy tracking arrives with the changes feed (M6)" />
          </h2>
          <div className="space-y-1.5">
            {deploys.map((d) => (
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
      </div>
    </div>
  );
}
