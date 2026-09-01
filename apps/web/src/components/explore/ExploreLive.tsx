"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus } from "lucide-react";
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
import {
  VALID_AGGS,
  type MetricAgg,
  type MetricCatalogEntry,
  type MetricRange,
  type MetricSeriesQuery,
  type MetricSeriesResult,
} from "@/lib/metrics-types";
import type { Dashboard } from "@/lib/dashboard-types";
import { layerColor } from "@/lib/layers";
import { SaveToDashboardLive } from "@/components/explore/SaveToDashboardLive";

/**
 * The explore live branch (D367): fed exclusively by `server/queries/metrics.ts`
 * through `explore/page.tsx` — no `@/mock/explore` import anywhere in this file
 * (A2). Filters live in the URL and a chip click is a fresh server render, the
 * same house pattern `TracesSearch`/`LogsExplorer` use for their bars: this
 * component reads its own current selection from `query` (already resolved and
 * deep-link-safe by the page) and never keeps a second copy of it in state.
 *
 * `ExploreChart.tsx` is mock-only (it calls `exploreSeries()` internally) —
 * this is the props-fed sibling D367 asks for, so the recharts styling below is
 * copied rather than shared.
 *
 * Save-to-dashboard (D433) is `SaveToDashboardLive`, shown only once a query is
 * resolved (`query !== null`): the mock's `SaveToDashboardModal` reads the mock
 * workspace store, so its markup is copied rather than imported. The
 * `dashboards` prop is a real, workspace-scoped read (`explore/page.tsx`'s live
 * branch, `server/dashboards.ts`'s `listDashboards`) — dashboards this sprint
 * finally persists in Postgres, not fixture state.
 */

/* tick/grid styling copied from ExploreChart.tsx for visual consistency */
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

const RANGE_OPTIONS: { value: MetricRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
];

const CHART_OPTIONS: { value: "line" | "area" | "bar"; label: string }[] = [
  { value: "line", label: "line" },
  { value: "area", label: "area" },
  { value: "bar", label: "bar" },
];

function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-faint">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[10.5px] ${
              value === o.value
                ? "border-line-strong bg-raised text-ink"
                : "border-line text-faint hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ExploreLive({
  catalog,
  query,
  result,
  seriesCap,
  capReached,
  dashboards,
}: {
  catalog: MetricCatalogEntry[];
  /** Resolved and deep-link-safe by `explore/page.tsx`; `null` only when the workspace has no metrics yet. */
  query: MetricSeriesQuery | null;
  result: MetricSeriesResult;
  /** `series-cap.ts`'s `SERIES_CAP` — the banner states the number the check below uses, so the two cannot drift apart. */
  seriesCap: number;
  /** Packet §2: this workspace's active-series count has reached the cap — computed from `metric_series`, never estimated. */
  capReached: boolean;
  /** This workspace's dashboards (D433), read by `explore/page.tsx`'s live branch and handed to `SaveToDashboardLive`. */
  dashboards: Dashboard[];
}) {
  const router = useRouter();
  const [chartType, setChartType] = useState<"line" | "area" | "bar">("line");
  const [showSave, setShowSave] = useState(false);
  const [toast, setToast] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  // D384: keyed on (name, type) — a dual-emitted name is two independently
  // selectable catalog rows, and `query.type` (now required on the contract)
  // is what tells them apart; matching on `name` alone could silently pick
  // the wrong one's `attrKeys`/aggregation vocabulary.
  const selected = query
    ? (catalog.find((m) => m.name === query.metric && m.type === query.type) ?? null)
    : null;

  const navigate = (
    metric: string,
    type: MetricCatalogEntry["type"],
    range: MetricRange,
    agg: MetricAgg,
    groupBy: string | null,
  ) => {
    const params = new URLSearchParams({ metric, type, range, agg });
    if (groupBy) params.set("group", groupBy);
    router.replace(`/app/explore?${params.toString()}`, { scroll: false });
  };

  const data = useMemo(
    () =>
      result.series[0]?.points.map((p, i) => ({
        t: p.t,
        ...Object.fromEntries(
          result.series.map((s) => [s.group ?? (selected?.name ?? "value"), s.points[i]?.v ?? null]),
        ),
      })) ?? [],
    [result, selected],
  );

  const palette = Object.values(layerColor);
  const seriesNames = result.series.map((s) => s.group ?? (selected?.name ?? "value"));

  const ChartComp = chartType === "area" ? AreaChart : chartType === "bar" ? BarChart : LineChart;

  const cap = (
    <div className="mb-4 rounded-lg border border-line-strong bg-overlay px-3.5 py-2.5">
      <p className="font-mono text-[11.5px] text-ink">
        Series limit reached ({seriesCap.toLocaleString("en-US")}) — data points for new series are
        being dropped.
      </p>
    </div>
  );

  if (catalog.length === 0 || !query) {
    return (
      <div className="flex h-full flex-col">
        <main className="flex-1 overflow-y-auto px-5 py-4">
          {capReached && cap}
          <div className="rounded-lg border border-line bg-surface px-3.5 py-5">
            <p className="text-[13px] text-ink">No metrics yet.</p>
            <p className="mt-1 max-w-prose text-[12.5px] leading-relaxed text-mid">
              Nothing has arrived on <code className="font-mono">/v1/metrics</code> for this
              workspace. Send an OTLP metrics export and it appears here — see the connect flows
              in{" "}
              <Link href="/app/connections" className="text-ink underline underline-offset-2">
                Connections
              </Link>
              .
            </p>
          </div>
        </main>
      </div>
    );
  }

  // Type-level only: `explore/page.tsx` resolves `query.metric` off the very
  // `catalog` array it passes here, so the lookup above always hits — this is
  // `find`'s `undefined` arm, not a state the page can produce.
  if (!selected) return null;

  return (
    <div className="flex h-full">
      <aside className="w-60 shrink-0 overflow-y-auto border-r border-line px-3 py-4">
        <h2 className="mb-2 px-1 font-mono text-[11px] uppercase tracking-widest text-faint">Metrics</h2>
        <div className="space-y-0.5">
          {catalog.map((m) => (
            <button
              key={`${m.name}:${m.type}`}
              type="button"
              onClick={() => navigate(m.name, m.type, query.range, VALID_AGGS[m.type][0], null)}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] ${
                m.name === query.metric && m.type === query.type
                  ? "bg-raised text-ink"
                  : "text-mid hover:bg-raised hover:text-ink"
              }`}
            >
              <span className="truncate">{m.name}</span>
              <span className="shrink-0 font-mono text-[9.5px] text-faint">{m.unit || m.type}</span>
            </button>
          ))}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto px-5 py-4">
        {capReached && cap}

        <div className="mb-4 flex items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-[19px] font-semibold text-ink">{query.metric}</h1>
            <p className="mt-0.5 font-mono text-[11px] text-faint">
              {selected.unit || selected.type} · last seen {selected.lastSeen}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowSave(true)}
            className="flex items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 py-1.5 font-mono text-[12px] text-ink hover:bg-overlay"
          >
            <Plus className="h-3.5 w-3.5" />
            Save to dashboard
          </button>
        </div>

        <div className="mb-4 flex flex-wrap gap-5 rounded-lg border border-line bg-surface p-3.5">
          <ChipGroup
            label="aggregation"
            options={VALID_AGGS[selected.type].map((a) => ({ value: a, label: a }))}
            value={query.agg}
            onChange={(agg) => navigate(query.metric, query.type, query.range, agg, query.groupBy)}
          />
          <ChipGroup
            label="group by"
            options={[
              { value: "", label: "none" },
              ...selected.attrKeys.map((k) => ({ value: k, label: k })),
            ]}
            value={query.groupBy ?? ""}
            onChange={(k) => navigate(query.metric, query.type, query.range, query.agg, k || null)}
          />
          <ChipGroup label="range" options={RANGE_OPTIONS} value={query.range} onChange={(r) => navigate(query.metric, query.type, r, query.agg, query.groupBy)} />
          <ChipGroup label="chart" options={CHART_OPTIONS} value={chartType} onChange={setChartType} />
        </div>

        <div className="rounded-lg border border-line bg-surface p-3.5">
          {/* D381: the truncation statement and the truncated data are one answer —
              rendered only when the result actually was truncated. */}
          {result.totalGroups > 10 && (
            <p className="mb-2.5 font-mono text-[10.5px] text-faint">
              showing top 10 of {result.totalGroups}
            </p>
          )}
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
                  value: selected.unit,
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
              {seriesNames.map((name, i) => {
                const color = palette[i % palette.length];
                // dataKey as a function (not the raw name string) avoids recharts/lodash
                // treating dots in series names as nested-path separators.
                const dataKey = (d: Record<string, number | null>) => d[name];
                if (chartType === "area") {
                  return (
                    <Area
                      key={name}
                      type="monotone"
                      name={name}
                      dataKey={dataKey}
                      stroke={color}
                      fill={color}
                      fillOpacity={0.14}
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls={false}
                    />
                  );
                }
                if (chartType === "bar") {
                  return <Bar key={name} name={name} dataKey={dataKey} fill={color} radius={[3, 3, 0, 0]} />;
                }
                return (
                  <Line
                    key={name}
                    type="monotone"
                    name={name}
                    dataKey={dataKey}
                    stroke={color}
                    dot={false}
                    strokeWidth={1.5}
                    connectNulls={false}
                  />
                );
              })}
            </ChartComp>
          </ResponsiveContainer>

          <div className="mt-2.5 flex flex-wrap items-center gap-3 border-t border-line pt-2.5">
            {seriesNames.map((name, i) => (
              <span key={name} className="flex items-center gap-1.5 font-mono text-[10.5px] text-mid">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: palette[i % palette.length] }} />
                {name}
              </span>
            ))}
          </div>
        </div>
      </main>

      {showSave && (
        <SaveToDashboardLive
          dashboards={dashboards}
          query={query}
          onClose={() => setShowSave(false)}
          onSaved={(dashboard) => {
            setShowSave(false);
            setToast({ id: dashboard.id, name: dashboard.name });
            // Nothing revalidates in the actions (actions.ts): the caller
            // refreshes, so the `dashboards` list this page shows — widget
            // counts, "full" at 12, a dashboard just created — is the store's
            // answer after this save, not before it.
            router.refresh();
          }}
        />
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-line bg-overlay px-4 py-3">
          <p className="font-mono text-[11.5px] text-ink">saved to {toast.name}</p>
          <Link
            href={`/app/dashboards/${toast.id}`}
            className="font-mono text-[11.5px] text-faint underline hover:text-ink"
          >
            View
          </Link>
        </div>
      )}
    </div>
  );
}
