import Link from "next/link";
import { connection } from "next/server";
import { ArrowUpRight } from "lucide-react";
import { topFailing } from "@/mock/metrics";
import { dataForSession, dataMode } from "@/server/data";
import { LatencyChart, RequestsChart, TokensChart } from "@/components/dash/Charts";
import { WatchWidgets } from "@/components/dash/WatchWidgets";
import { OnboardingChecklist } from "@/components/dash/OnboardingChecklist";
import { LayerChip } from "@/components/ui/LayerChip";
import { SampleMark } from "@/components/ui/SampleMark";
import type { Layer } from "@/lib/types";

/**
 * Per-widget honesty marker (D21 extended by F6): in live mode this page mixes
 * facade-backed charts with widgets that still render mock content, so each
 * unwired widget says so. Delete the marker at the call site as M2/M3 wires
 * that widget to real data.
 */
const SAMPLE_TITLE = "this widget still renders sample content — not from your ingested telemetry";

/**
 * Marks a widget that renders nothing until it has hydrated (and can vanish
 * again when dismissed). The marker carries no `<div>` of its own and every
 * such widget's root is one, so the wrapper hides itself whenever the widget is
 * absent — a lone SAMPLE chip with no widget under it would be its own lie.
 */
function SampleWidget({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`[&:not(:has(div))]:hidden ${className}`}>
      <p className="mb-1">
        <SampleMark title={SAMPLE_TITLE} />
      </p>
      {children}
    </div>
  );
}

function Card({
  title,
  href,
  hrefLabel,
  sample,
  children,
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
  sample?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
          {title}
          {sample && (
            <>
              {" "}
              <SampleMark title={SAMPLE_TITLE} />
            </>
          )}
        </h2>
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

/** Live mode with nothing ingested yet: a real zero state, never mock points (D13). */
function NoData() {
  return (
    <div className="flex h-[170px] items-center justify-center font-mono text-[11px] text-faint">
      no traces in this window
    </div>
  );
}

export default async function OverviewPage() {
  const live = dataMode === "live";
  // Live numbers must not be baked into a static prerender (D27a) — connection()
  // holds rendering until a real request. Mock mode stays static as before.
  if (live) await connection();
  // This page both reads and NAMES its workspace, so it holds the scope object:
  // the label below is the workspace these numbers were queried under, not a
  // second resolution that could disagree with them (D13/D21).
  const data = await dataForSession();
  const { points, stats } = await data.getOverview();
  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Overview</h1>
        <span className="flex items-center gap-2 font-mono text-[11px] text-faint">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-ok)" }} />
          {live ? (
            <>
              ingesting <SampleMark title={SAMPLE_TITLE} /> · {data.workspaceId} · last 6h
            </>
          ) : (
            <>ingesting · loopwork-prod · last 6h</>
          )}
        </span>
      </div>

      {live ? (
        <SampleWidget>
          <OnboardingChecklist />
        </SampleWidget>
      ) : (
        <OnboardingChecklist />
      )}

      {/* stat row */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
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

      <div className="grid gap-3 lg:grid-cols-2" data-tour="overview-charts">
        <Card title="requests & errors" href="/app/traces?status=error" hrefLabel="view errors">
          {points.length ? <RequestsChart data={points} deployMarks={!live} /> : <NoData />}
        </Card>
        <Card title="latency" href="/app/traces?minMs=5000" hrefLabel="view slow traces">
          {points.length ? <LatencyChart data={points} deployMarks={!live} /> : <NoData />}
        </Card>
        <Card title="token spend" href="/app/traces">
          {points.length ? <TokensChart data={points} /> : <NoData />}
        </Card>
        <Card
          title="top failing operations"
          href="/app/traces?status=error"
          hrefLabel="view errors"
          sample={live}
        >
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

      {live ? (
        <SampleWidget className="mt-4">
          <WatchWidgets />
        </SampleWidget>
      ) : (
        <WatchWidgets />
      )}
    </div>
  );
}
