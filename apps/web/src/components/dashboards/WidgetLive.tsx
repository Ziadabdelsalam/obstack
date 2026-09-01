"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { layerColor } from "@/lib/layers";
import { foldCaption, groupRows, groupsCaption, isEmptyResult, statView } from "@/lib/widget-view";
import type { DashboardWidget, WidgetLoad } from "@/lib/dashboard-types";
import type { MetricSeriesResult } from "@/lib/metrics-types";

/**
 * The live widget card (S6.3, D428): props-fed, zero fetching — `widget` is
 * the stored shape, `load` is that widget's own slot from
 * `loadWidgetResults` (T2), `href` (when given) makes the title a link to
 * the widget's home dashboard. Recharts styling and `fmtVal` are copied from
 * `ExploreLive.tsx` (D391 — no shared chart module across the mock/live
 * boundary); the fold math (D427) lives in `lib/widget-view.ts`, pure and
 * unit-tested, because a client component using recharts cannot be imported
 * under this repo's `--conditions react-server` test harness.
 */

/* tick/grid styling + fmtVal copied from ExploreLive.tsx for visual consistency (D391) */
const TICK_STYLE = { fill: "#5c6672", fontSize: 10, fontFamily: "var(--font-jetbrains)" };
const GRID_COLOR = "rgba(48,56,69,0.5)";

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
}

function MiniTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number | null; color?: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line-strong bg-overlay px-2.5 py-1.5 shadow-xl">
      <p className="mb-1 font-mono text-[10px] text-faint">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: p.color }} />
          <span className="text-mid">{p.name}</span>
          <span className="ml-auto pl-3">{p.value == null ? "—" : fmtVal(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

const PALETTE = Object.values(layerColor);

function TimeseriesBody({ result, widget }: { result: MetricSeriesResult; widget: DashboardWidget }) {
  const names = result.series.map((s) => s.group ?? widget.metric);
  const data = useMemo(
    () =>
      result.series[0]?.points.map((p, i) => ({
        t: p.t,
        ...Object.fromEntries(names.map((name, si) => [name, result.series[si]?.points[i]?.v ?? null])),
      })) ?? [],
    [result, names],
  );
  const caption = groupsCaption(result.series.length, result.totalGroups);

  return (
    <div>
      {caption && <p className="mb-2 font-mono text-[10px] text-faint">{caption}</p>}
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="t" tick={TICK_STYLE} tickLine={false} axisLine={false} interval={5} />
          <YAxis tick={TICK_STYLE} tickLine={false} axisLine={false} width={40} />
          <Tooltip content={<MiniTooltip />} cursor={{ stroke: GRID_COLOR }} />
          {names.map((name, i) => (
            // dataKey as a function (not the raw name string) avoids recharts/lodash treating dots
            // in series names (e.g. "service.name" values) as nested-path separators.
            <Line
              key={name}
              type="monotone"
              name={name}
              dataKey={(d: Record<string, number | null>) => d[name]}
              stroke={PALETTE[i % PALETTE.length]}
              dot={false}
              strokeWidth={1.5}
              connectNulls={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {names.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-line pt-2">
          {names.map((name, i) => (
            <span key={name} className="flex items-center gap-1.5 font-mono text-[10px] text-mid">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: PALETTE[i % PALETTE.length] }} />
              {name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function StatBody({ result, widget }: { result: MetricSeriesResult; widget: DashboardWidget }) {
  const view = statView(result, widget);
  if (view.empty) return <p className="text-[12px] text-faint">no points in the last {widget.range}</p>;
  return (
    <div>
      <p className="text-2xl font-semibold text-ink">{fmtVal(view.value)}</p>
      <p className="mt-1 font-mono text-[11px] text-faint">{view.caption}</p>
    </div>
  );
}

function TopNBody({ result, widget }: { result: MetricSeriesResult; widget: DashboardWidget }) {
  const { rows, totalGroups } = groupRows(result, widget);
  const max = Math.max(0, ...rows.map((r) => r.fold.value ?? 0)) || 1;
  const caption = groupsCaption(rows.length, totalGroups);

  return (
    <div>
      {caption && <p className="mb-2 font-mono text-[10px] text-faint">{caption}</p>}
      <div className="space-y-2.5">
        {rows.map((r, i) => (
          <div key={r.group}>
            <div className="flex items-center gap-2">
              <span className="w-28 shrink-0 truncate font-mono text-[10.5px] text-mid">{r.group}</span>
              <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-overlay">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(2, ((r.fold.value ?? 0) / max) * 100)}%`,
                    background: PALETTE[i % PALETTE.length],
                  }}
                />
              </div>
              <span className="w-14 shrink-0 text-right font-mono text-[10.5px] text-ink">
                {r.fold.value === null ? "—" : fmtVal(r.fold.value)}
              </span>
            </div>
            <p className="mt-0.5 pl-28 font-mono text-[9.5px] text-faint">{foldCaption(r.fold, widget.range)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TableBody({ result, widget }: { result: MetricSeriesResult; widget: DashboardWidget }) {
  const { rows, totalGroups } = groupRows(result, widget);
  const caption = groupsCaption(rows.length, totalGroups);

  return (
    <div>
      {caption && <p className="mb-2 font-mono text-[10px] text-faint">{caption}</p>}
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
            <th className="pb-1.5 font-medium">group</th>
            <th className="pb-1.5 text-right font-medium">value</th>
            <th className="pb-1.5 text-right font-medium">buckets</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group} className="border-b border-line/50 last:border-0">
              <td className="py-[6px] font-mono text-[10.5px] text-mid">{r.group}</td>
              <td className="py-[6px] text-right font-mono text-[10.5px] text-ink">
                {r.fold.value === null ? "—" : fmtVal(r.fold.value)}
              </td>
              <td className="py-[6px] text-right font-mono text-[10.5px] text-faint">
                {r.fold.n}/{r.fold.total}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WidgetLive({
  widget,
  load,
  href,
}: {
  widget: DashboardWidget;
  /** This widget's own slot from `loadWidgetResults` — a failure here never takes the rest of the page down. */
  load: WidgetLoad;
  /** The widget's home dashboard, when the card should link there (the overview watch, D425). */
  href?: string;
}) {
  const title = (
    <h3 className="truncate font-mono text-[11px] uppercase tracking-widest text-faint">{widget.title}</h3>
  );

  return (
    <div className="rounded-lg border border-line bg-surface p-3.5">
      <div className="mb-2.5">
        {href ? (
          <Link href={href} className="hover:text-ink">
            {title}
          </Link>
        ) : (
          title
        )}
      </div>
      {!load.ok ? (
        <p className="text-[12px] text-faint">couldn&apos;t load this widget</p>
      ) : isEmptyResult(load.result) ? (
        <p className="text-[12px] text-faint">no points in the last {widget.range}</p>
      ) : widget.kind === "timeseries" ? (
        <TimeseriesBody result={load.result} widget={widget} />
      ) : widget.kind === "stat" ? (
        <StatBody result={load.result} widget={widget} />
      ) : widget.kind === "topn" ? (
        <TopNBody result={load.result} widget={widget} />
      ) : (
        <TableBody result={load.result} widget={widget} />
      )}
    </div>
  );
}
