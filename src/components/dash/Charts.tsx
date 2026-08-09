"use client";

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
import type { MetricPoint } from "@/mock/metrics";

/* chart series colors — validated against #12151a (dataviz six checks) */
const C = {
  blue: "#3b82f6",
  red: "#ef4444",
  amber: "#d97706",
  pink: "#db2777",
  grid: "rgba(48,56,69,0.5)",
  tick: "#5c6672",
};

const tickStyle = {
  fill: C.tick,
  fontSize: 10,
  fontFamily: "var(--font-jetbrains)",
};

function DarkTooltip({
  active,
  payload,
  label,
  fmt,
}: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
  fmt?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border border-line-strong bg-overlay px-2.5 py-1.5 shadow-xl">
      <p className="mb-1 font-mono text-[10px] text-faint">{label}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-1.5 font-mono text-[11px] text-ink">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: p.color }} />
          <span className="text-mid">{p.name}</span>
          <span className="ml-auto pl-3">{fmt ? fmt(p.value) : p.value.toLocaleString()}</span>
        </p>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-3">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 font-mono text-[10px] text-mid">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

export function RequestsChart({ data }: { data: MetricPoint[] }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Legend
          items={[
            { label: "requests", color: C.blue },
            { label: "errors", color: C.red },
          ]}
        />
      </div>
      <ResponsiveContainer width="100%" height={170}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="t" tick={tickStyle} tickLine={false} axisLine={false} interval={5} />
          <YAxis tick={tickStyle} tickLine={false} axisLine={false} width={54} />
          <Tooltip content={<DarkTooltip />} cursor={{ stroke: C.grid }} />
          <Area
            type="monotone"
            dataKey="requests"
            stroke={C.blue}
            strokeWidth={2}
            fill={C.blue}
            fillOpacity={0.12}
            dot={false}
          />
          <Area
            type="monotone"
            dataKey="errors"
            stroke={C.red}
            strokeWidth={2}
            fill={C.red}
            fillOpacity={0.18}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LatencyChart({ data }: { data: MetricPoint[] }) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <Legend
          items={[
            { label: "p50", color: C.blue },
            { label: "p95", color: C.amber },
          ]}
        />
      </div>
      <ResponsiveContainer width="100%" height={170}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: -18, bottom: 0 }}>
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="t" tick={tickStyle} tickLine={false} axisLine={false} interval={5} />
          <YAxis
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            width={54}
            tickFormatter={(v: number) => `${(v / 1000).toFixed(1)}s`}
          />
          <Tooltip
            content={<DarkTooltip fmt={(v) => `${(v / 1000).toFixed(2)}s`} />}
            cursor={{ stroke: C.grid }}
          />
          <Line type="monotone" dataKey="p50" stroke={C.blue} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="p95" stroke={C.amber} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TokensChart({ data }: { data: MetricPoint[] }) {
  return (
    <div>
      <div className="mb-2">
        <Legend items={[{ label: "tokens / 15min", color: C.pink }]} />
      </div>
      <ResponsiveContainer width="100%" height={170}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: -10, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid stroke={C.grid} vertical={false} />
          <XAxis dataKey="t" tick={tickStyle} tickLine={false} axisLine={false} interval={5} />
          <YAxis
            tick={tickStyle}
            tickLine={false}
            axisLine={false}
            width={46}
            tickFormatter={(v: number) => `${Math.round(v / 1000)}k`}
          />
          <Tooltip
            content={<DarkTooltip fmt={(v) => `${(v / 1000).toFixed(0)}k tokens`} />}
            cursor={{ fill: "rgba(48,56,69,0.25)" }}
          />
          <Bar dataKey="tokens" fill={C.pink} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
