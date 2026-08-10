"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { exploreSeries, metricCatalog, type ExploreQuery } from "@/mock/explore";

/* tick/grid styling copied from src/components/dash/Charts.tsx for visual consistency */
const TICK_STYLE = { fill: "#5c6672", fontSize: 10, fontFamily: "var(--font-jetbrains)" };
const GRID_COLOR = "rgba(48,56,69,0.5)";

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

export function ExploreChart({
  query,
  chartType,
}: {
  query: ExploreQuery;
  chartType: "line" | "area" | "bar";
}) {
  const def = metricCatalog.find((m) => m.id === query.metricId) ?? metricCatalog[0];

  const series = useMemo(() => {
    const raw = exploreSeries(query);
    // exploreSeries always colors a lone "none"-groupBy series as api-blue; derive from the
    // metric's own layer instead so single-series charts aren't all blue.
    return query.groupBy === "none" ? raw.map((s) => ({ ...s, color: `var(--color-${def.layer})` })) : raw;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.metricId, query.service, query.env, query.groupBy, query.rangeHours, def.layer]);

  const data = useMemo(
    () =>
      series[0]?.points.map((p, i) => ({
        t: p.t,
        ...Object.fromEntries(series.map((s) => [s.name, s.points[i].v])),
      })) ?? [],
    [series],
  );

  const ChartComp = chartType === "area" ? AreaChart : chartType === "bar" ? BarChart : LineChart;

  return (
    <div>
      <ResponsiveContainer width="100%" height={320}>
        <ChartComp data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID_COLOR} vertical={false} />
          <XAxis dataKey="t" tick={TICK_STYLE} tickLine={false} axisLine={false} interval={5} />
          <YAxis
            tick={TICK_STYLE}
            tickLine={false}
            axisLine={false}
            width={56}
            label={{
              value: def.unit,
              angle: -90,
              position: "insideLeft",
              fill: "#5c6672",
              fontSize: 10,
              fontFamily: "var(--font-jetbrains)",
            }}
          />
          <Tooltip
            content={<MiniTooltip />}
            cursor={chartType === "bar" ? { fill: "rgba(48,56,69,0.25)" } : { stroke: GRID_COLOR }}
          />
          {series.map((s) => {
            // dataKey as a function (not the raw name string) avoids recharts/lodash treating
            // dots in series names (e.g. model ids like "gpt-5.2") as nested-path separators.
            const dataKey = (d: Record<string, number>) => d[s.name];
            if (chartType === "area") {
              return (
                <Area
                  key={s.name}
                  type="monotone"
                  name={s.name}
                  dataKey={dataKey}
                  stroke={s.color}
                  fill={s.color}
                  fillOpacity={0.14}
                  strokeWidth={1.5}
                  dot={false}
                />
              );
            }
            if (chartType === "bar") {
              return <Bar key={s.name} name={s.name} dataKey={dataKey} fill={s.color} radius={[3, 3, 0, 0]} />;
            }
            return (
              <Line
                key={s.name}
                type="monotone"
                name={s.name}
                dataKey={dataKey}
                stroke={s.color}
                dot={false}
                strokeWidth={1.5}
              />
            );
          })}
        </ChartComp>
      </ResponsiveContainer>

      <div className="mt-2.5 flex flex-wrap items-center gap-3 border-t border-line pt-2.5">
        {series.map((s) => (
          <span key={s.name} className="flex items-center gap-1.5 font-mono text-[10.5px] text-mid">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
      </div>
    </div>
  );
}
