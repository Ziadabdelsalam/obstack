"use client";

import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { exploreSeries, metricCatalog, type ExploreSeries } from "@/mock/explore";
import type { Widget } from "@/mock/dashboards";

/* tick/grid styling copied from src/components/dash/Charts.tsx for visual consistency */
const TICK_STYLE = { fill: "#5c6672", fontSize: 10, fontFamily: "var(--font-jetbrains)" };
const GRID_COLOR = "rgba(48,56,69,0.5)";

/** units where "up" reads as bad (latency/error/cost-ish); everything else reads "up is good". */
const BAD_UNITS = new Set(["%", "ms", "$/hr", "/hr"]);

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString(undefined, { maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 });
}

function MiniTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string }[];
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
          <span className="ml-auto pl-3">{fmtVal(p.value ?? 0)}</span>
        </p>
      ))}
    </div>
  );
}

export function WidgetCard({
  widget,
  editing,
  onRemove,
  onMove,
}: {
  widget: Widget;
  editing?: boolean;
  onRemove?: () => void;
  onMove?: (dir: "up" | "down") => void;
}) {
  const def = metricCatalog.find((m) => m.id === widget.metricId) ?? metricCatalog[0];

  const series = useMemo(() => {
    const raw = exploreSeries({
      metricId: widget.metricId,
      service: "all",
      env: "prod",
      groupBy: widget.groupBy,
      rangeHours: 6,
    });
    // exploreSeries always colors a lone "none"-groupBy series as api-blue; derive from the
    // metric's own layer instead so single-series widgets aren't all blue.
    return widget.groupBy === "none" ? raw.map((s) => ({ ...s, color: `var(--color-${def.layer})` })) : raw;
  }, [widget.metricId, widget.groupBy, def.layer]);

  return (
    <div className="rounded-lg border border-line bg-surface p-3.5">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="truncate font-mono text-[11px] uppercase tracking-widest text-faint">{widget.title}</h3>
        {editing && (
          <div className="flex shrink-0 items-center gap-1">
            {onMove && (
              <>
                <button
                  type="button"
                  onClick={() => onMove("up")}
                  aria-label="Move widget up"
                  className="rounded p-0.5 text-faint hover:bg-raised hover:text-ink"
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => onMove("down")}
                  aria-label="Move widget down"
                  className="rounded p-0.5 text-faint hover:bg-raised hover:text-ink"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                aria-label="Remove widget"
                className="rounded p-0.5 text-faint hover:bg-raised hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {widget.kind === "timeseries" && <TimeseriesBody series={series} />}
      {widget.kind === "stat" && <StatBody series={series} unit={def.unit} />}
      {widget.kind === "topn" && <TopNBody series={series} />}
      {widget.kind === "table" && <TableBody series={series} />}
    </div>
  );
}

function TimeseriesBody({ series }: { series: ExploreSeries[] }) {
  const data =
    series[0]?.points.map((p, i) => ({
      t: p.t,
      ...Object.fromEntries(series.map((s) => [s.name, s.points[i].v])),
    })) ?? [];

  return (
    <div>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-3">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1.5 font-mono text-[10px] text-mid">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="t" tick={TICK_STYLE} tickLine={false} axisLine={false} interval={5} />
          <Tooltip content={<MiniTooltip />} cursor={{ stroke: GRID_COLOR }} />
          {series.map((s) => (
            // dataKey as a function (not the raw name string) avoids recharts/lodash treating
            // dots in series names (e.g. model ids like "gpt-5.2") as nested-path separators.
            <Line
              key={s.name}
              type="monotone"
              name={s.name}
              dataKey={(d: Record<string, number>) => d[s.name]}
              stroke={s.color}
              dot={false}
              strokeWidth={1.5}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function StatBody({ series, unit }: { series: ExploreSeries[]; unit: string }) {
  const pts = series[0]?.points ?? [];
  const first = pts[0]?.v ?? 0;
  const last = pts[pts.length - 1]?.v ?? 0;
  const deltaPct = first === 0 ? (last === 0 ? 0 : 100) : ((last - first) / first) * 100;
  const isBadUnit = BAD_UNITS.has(unit);
  const up = deltaPct >= 0;
  // Literal brief rule: err only when the metric went up AND the unit is latency/error/cost-ish;
  // every other case (including a decreasing "good" metric) reads as ok.
  const deltaColor = up && isBadUnit ? "var(--color-err)" : "var(--color-ok)";

  return (
    <div>
      <p className="text-2xl font-semibold text-ink">{fmtVal(last)}</p>
      <p className="mt-1 flex items-center gap-2 font-mono text-[11px] text-faint">
        <span>{unit}</span>
        <span style={{ color: deltaColor }}>
          {up ? "+" : ""}
          {deltaPct.toFixed(1)}%
        </span>
      </p>
    </div>
  );
}

function TopNBody({ series }: { series: ExploreSeries[] }) {
  const rows = series
    .map((s) => ({
      name: s.name,
      color: s.color,
      avg: s.points.reduce((a, p) => a + p.v, 0) / (s.points.length || 1),
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);
  const max = rows[0]?.avg || 1;

  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.name} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate font-mono text-[10.5px] text-mid">{r.name}</span>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-overlay">
            <div
              className="h-full rounded-full"
              style={{ width: `${Math.max(2, (r.avg / max) * 100)}%`, background: r.color }}
            />
          </div>
          <span className="w-14 shrink-0 text-right font-mono text-[10.5px] text-ink">{fmtVal(r.avg)}</span>
        </div>
      ))}
    </div>
  );
}

function TableBody({ series }: { series: ExploreSeries[] }) {
  const rows = series.map((s) => {
    const vals = s.points.map((p) => p.v);
    const avg = vals.reduce((a, v) => a + v, 0) / (vals.length || 1);
    const max = Math.max(...vals);
    const last = vals[vals.length - 1] ?? 0;
    return { name: s.name, color: s.color, avg, max, last };
  });

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
          <th className="pb-1.5 font-medium">name</th>
          <th className="pb-1.5 text-right font-medium">avg</th>
          <th className="pb-1.5 text-right font-medium">max</th>
          <th className="pb-1.5 text-right font-medium">last</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name} className="border-b border-line/50 last:border-0">
            <td className="py-[6px] font-mono text-[10.5px] text-mid">
              <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full" style={{ background: r.color }} />
              {r.name}
            </td>
            <td className="py-[6px] text-right font-mono text-[10.5px] text-ink">{fmtVal(r.avg)}</td>
            <td className="py-[6px] text-right font-mono text-[10.5px] text-ink">{fmtVal(r.max)}</td>
            <td className="py-[6px] text-right font-mono text-[10.5px] text-ink">{fmtVal(r.last)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
