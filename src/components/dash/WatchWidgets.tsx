"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip } from "recharts";
import {
  defaultWidgets,
  seriesFor,
  statsFor,
  widgetMeta,
  widgetTitle,
  type WidgetConfig,
  type WidgetType,
} from "@/mock/watch";

/* validated chart colors (dataviz six checks, dark surface) */
const C = { blue: "#3b82f6", amber: "#d97706", pink: "#db2777", red: "#ef4444" };

const toneColor = { ok: "var(--color-ok)", warn: "var(--color-warn)", err: "var(--color-err)" };

const lineColorByType: Record<WidgetType, string> = {
  service: C.blue,
  "service-compare": C.blue,
  route: C.amber,
  pod: C.amber,
  model: C.pink,
  tool: C.red,
  queue: C.blue,
  pipeline: C.blue,
};

const STORAGE_KEY = "obstack-watch-widgets";

function Spark({ keys, colors }: { keys: string[]; colors: string[] }) {
  const series = keys.map((k, idx) => seriesFor(k, 100, 60).map((v) => ({ i: idx, v })));
  const data = series[0].map((_, i) => {
    const row: Record<string, number> = { x: i };
    series.forEach((s, idx) => (row[`s${idx}`] = s[i].v));
    return row;
  });
  return (
    <ResponsiveContainer width="100%" height={54}>
      <LineChart data={data} margin={{ top: 4, right: 2, left: 2, bottom: 2 }}>
        <Tooltip
          content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="rounded-md border border-line-strong bg-overlay px-2 py-1 font-mono text-[10.5px] text-ink">
                {payload.map((p, i) => (
                  <span key={i} className="mr-2" style={{ color: colors[i] }}>
                    {Math.round(p.value as number)}
                  </span>
                ))}
              </div>
            ) : null
          }
          cursor={{ stroke: "rgba(48,56,69,0.6)" }}
        />
        {keys.map((_, idx) => (
          <Line
            key={idx}
            type="monotone"
            dataKey={`s${idx}`}
            stroke={colors[idx]}
            strokeWidth={1.5}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

function WidgetCard({ config, onRemove }: { config: WidgetConfig; onRemove: () => void }) {
  const meta = widgetMeta[config.type];
  const stats = statsFor(config);
  const compare = config.type === "service-compare";
  const sparkKeys = compare ? [`${config.type}:${config.a}`, `${config.type}:${config.b}`] : [`${config.type}:${config.a}`];
  const sparkColors = compare ? [C.blue, C.amber] : [lineColorByType[config.type]];

  return (
    <section className="group relative rounded-lg border border-line bg-surface p-3.5">
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${meta.label} widget`}
        className="absolute top-2 right-2 rounded p-1 text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:bg-overlay hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
      <p className="font-mono text-[10px] uppercase tracking-widest text-faint">{meta.label}</p>
      <p className="mt-0.5 truncate font-mono text-[13px] text-ink">{widgetTitle(config)}</p>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {stats.map((s) => (
          <span key={s.label} className="flex items-baseline gap-1.5">
            <span className="max-w-[110px] truncate font-mono text-[9.5px] uppercase tracking-wider text-faint">
              {s.label}
            </span>
            <span
              className="font-mono text-[12.5px]"
              style={{ color: s.tone ? toneColor[s.tone] : "var(--color-ink)" }}
            >
              {s.value}
            </span>
          </span>
        ))}
      </div>
      <div className="mt-2">
        <Spark keys={sparkKeys} colors={sparkColors} />
      </div>
      {compare && (
        <div className="mt-1 flex gap-3">
          {[config.a, config.b].map((name, i) => (
            <span key={name} className="flex items-center gap-1.5 font-mono text-[9.5px] text-mid">
              <span className="h-1.5 w-1.5 rounded-[1px]" style={{ background: [C.blue, C.amber][i] }} />
              {name}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

function AddWidgetModal({
  onAdd,
  onClose,
}: {
  onAdd: (c: Omit<WidgetConfig, "id">) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<WidgetType>("service");
  const meta = widgetMeta[type];
  const [a, setA] = useState(meta.options[0]);
  const [b, setB] = useState(meta.options[1] ?? "");

  const pickType = (t: WidgetType) => {
    setType(t);
    setA(widgetMeta[t].options[0]);
    setB(widgetMeta[t].options[1] ?? "");
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Add widget"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-line-strong bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-medium text-ink">Add a widget</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1.5 text-faint hover:bg-overlay hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-4 py-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-faint">
            what do you want to watch?
          </p>
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(widgetMeta) as WidgetType[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => pickType(t)}
                className="rounded-md border p-2.5 text-left transition-colors"
                style={{
                  borderColor:
                    type === t
                      ? "color-mix(in srgb, var(--color-api) 50%, var(--color-line))"
                      : "var(--color-line)",
                  background: type === t ? "color-mix(in srgb, var(--color-api) 6%, transparent)" : "var(--color-raised)",
                }}
              >
                <span className="block text-[12.5px] font-medium text-ink">{widgetMeta[t].label}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-mid">
                  {widgetMeta[t].description}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <select
              value={a}
              onChange={(e) => setA(e.target.value)}
              aria-label="Watch target"
              className="min-w-[200px] flex-1 rounded-md border border-line bg-raised px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-line-strong focus:outline-none"
            >
              {meta.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {meta.needsB && (
              <>
                <span className="font-mono text-[11px] text-faint">vs</span>
                <select
                  value={b}
                  onChange={(e) => setB(e.target.value)}
                  aria-label="Comparison target"
                  className="min-w-[200px] flex-1 rounded-md border border-line bg-raised px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-line-strong focus:outline-none"
                >
                  {meta.options
                    .filter((o) => o !== a)
                    .map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                </select>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              onAdd({ type, a, b: meta.needsB ? b : undefined });
              onClose();
            }}
            className="mt-4 w-full rounded-md py-2 text-[13px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            Add to Overview
          </button>
        </div>
      </div>
    </div>
  );
}

export function WatchWidgets() {
  const [widgets, setWidgets] = useState<WidgetConfig[] | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      setWidgets(raw ? (JSON.parse(raw) as WidgetConfig[]) : defaultWidgets);
    } catch {
      setWidgets(defaultWidgets);
    }
  }, []);

  useEffect(() => {
    if (widgets) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
      } catch {
        /* private mode etc. — widget state just won't persist */
      }
    }
  }, [widgets]);

  if (!widgets) return null;

  return (
    <>
      <div className="mt-4 mb-2 flex items-center justify-between">
        <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">
          your watches · {widgets.length}
        </h2>
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid hover:border-line-strong hover:text-ink"
        >
          <Plus className="h-3.5 w-3.5" /> Add widget
        </button>
      </div>

      {widgets.length === 0 ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex w-full items-center justify-center rounded-lg border border-dashed border-line-strong bg-surface/50 py-8 text-[13px] text-faint hover:text-mid"
        >
          Nothing pinned yet — add a service, pod, route, model, tool or queue to watch it here.
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {widgets.map((w) => (
            <WidgetCard
              key={w.id}
              config={w}
              onRemove={() => setWidgets((ws) => (ws ?? []).filter((x) => x.id !== w.id))}
            />
          ))}
        </div>
      )}

      {adding && (
        <AddWidgetModal
          onAdd={(c) =>
            setWidgets((ws) => [...(ws ?? []), { ...c, id: `w-${Date.now().toString(36)}` }])
          }
          onClose={() => setAdding(false)}
        />
      )}
    </>
  );
}
