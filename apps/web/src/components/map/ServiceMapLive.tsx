import { fmtMs } from "@/lib/format";
import { layerColor, layerLabel, layerOrder } from "@/lib/layers";
import { mapLayout, NODE_H, NODE_W, type NodePosition } from "@/lib/map-layout";
import { TRACES_PATH } from "@/lib/traces-filter";
import {
  ERR_ERROR_PCT,
  topologyStatus,
  WARN_ERROR_PCT,
  WINDOW_HOURS,
  type Topology,
  type TopologyStatus,
} from "@/lib/topology-types";

/**
 * The service map, live-wired (D367/D396): a SERVER component (D392) fed by
 * `server/queries/topology.ts` through `map/page.tsx` — no `@/mock/` import,
 * and no `"use client"`, because nothing here is interactive. A node is a link,
 * which is a URL, not a click handler; there is no interactivity JS for
 * interactivity that does not exist.
 *
 * `ServiceMapMock.tsx` is the demo's own picture and keeps its own constants
 * and its hand-placed coordinates; the geometry below is duplicated rather than
 * shared (D391) because the two draw different things: the mock draws a story,
 * this draws whatever the workspace actually sent.
 *
 * Every number rendered here is stated in the words of its rule (D13): the
 * window, the rate's denominator, the error ratio, whose error rate an edge
 * carries, what makes a service an entry point, and what the cap dropped.
 */

const statusColor: Record<TopologyStatus, string> = {
  ok: "var(--color-ok)",
  warn: "var(--color-warn)",
  err: "var(--color-err)",
};

/** The legend READS the thresholds rather than restating them: one definition (D396), so the printed rule and `topologyStatus` cannot drift. */
const statusLegend: Record<TopologyStatus, string> = {
  ok: `healthy <${WARN_ERROR_PCT}% err`,
  warn: `degraded ${WARN_ERROR_PCT}–${ERR_ERROR_PCT}%`,
  err: `erroring ≥${ERR_ERROR_PCT}%`,
};

/**
 * A per-minute rate over a 24h window gets very small: one call all day is
 * 0.0007/min, and `toFixed(2)` would print that as "0.00/min" — a real hop
 * rendered as no traffic. Below what two decimals can express, say so.
 */
function perMin(n: number): string {
  if (n >= 10) return `${Math.round(n).toLocaleString("en-US")}/min`;
  if (n >= 0.1) return `${n.toFixed(1)}/min`;
  if (n >= 0.01) return `${n.toFixed(2)}/min`;
  if (n > 0) return `<0.01/min`;
  return "0/min";
}

/** SVG text neither wraps nor truncates; the full name rides along in the group's `aria-label`. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const center = (p: NodePosition) => ({ cx: p.x + NODE_W / 2, cy: p.y + NODE_H / 2 });

/** point on the rect border toward the other node's center */
function anchor(p: NodePosition, toward: { cx: number; cy: number }) {
  const { cx, cy } = center(p);
  const dx = toward.cx - cx;
  const dy = toward.cy - cy;
  const sx = dx === 0 ? Infinity : NODE_W / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : NODE_H / 2 / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function ServiceMapLive({ topology }: { topology: Topology }) {
  const { nodes, edges, totalServices, nodeCap } = topology;
  const layout = mapLayout(nodes);
  // In `layerOrder`, so the legend reads left to right like the columns do.
  const present = new Set(nodes.map((n) => n.layer));
  const layers = layerOrder.filter((l) => present.has(l));

  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-[19px] font-semibold text-ink">Service map</h1>
        <div className="flex items-center gap-4 font-mono text-[10.5px] text-faint">
          {(["ok", "warn", "err"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor[s] }} />
              {statusLegend[s]}
            </span>
          ))}
          <span>last {WINDOW_HOURS}h</span>
        </div>
      </div>

      <p className="mb-3 max-w-prose text-[12.5px] leading-relaxed text-mid">
        Every service that sent a span in the last {WINDOW_HOURS}h, one column per layer. An edge is
        a parent span in one service with a child span in another, in the same trace; it carries the
        child&apos;s error rate. Rates are counts over the {WINDOW_HOURS}h window; error % is
        error spans ÷ spans; p95 is over the same window.
      </p>

      {totalServices > nodeCap && (
        <div className="mb-3 rounded-lg border border-line-strong bg-overlay px-3.5 py-2.5">
          <p className="font-mono text-[11.5px] text-ink">
            showing {nodeCap} of {totalServices} services by span volume — the edges drawn are those
            between the services shown.
          </p>
        </div>
      )}

      {layers.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-faint">
          {layers.map((layer) => (
            <span key={layer} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-[1px]" style={{ background: layerColor[layer] }} />
              {layerLabel[layer]}
            </span>
          ))}
          <span>column = layer (the layer most of the service&apos;s spans carry)</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-line bg-surface" data-tour="map">
        {nodes.length === 0 ? (
          <p className="px-3.5 py-5 text-[13px] text-ink">
            No service has sent a span in the last {WINDOW_HOURS}h.
          </p>
        ) : (
          <svg
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            width={layout.width}
            height={layout.height}
            className="max-w-none"
            role="img"
            aria-label="Service topology map"
          >
            {/* edges */}
            {edges.map((e) => {
              const from = layout.positions.get(e.from);
              const to = layout.positions.get(e.to);
              // `queryTopology` already dropped edges naming an uncapped
              // service, so both lookups hit; this is `get`'s undefined arm.
              if (!from || !to) return null;
              const p1 = anchor(from, center(to));
              const p2 = anchor(to, center(from));
              const status = topologyStatus(e.errorPct);
              const stroke = status === "ok" ? "var(--color-line-strong)" : statusColor[status];
              const mx = (p1.x + p2.x) / 2;
              const my = (p1.y + p2.y) / 2;
              return (
                <g key={`${e.from}-${e.to}`}>
                  <line
                    x1={p1.x}
                    y1={p1.y}
                    x2={p2.x}
                    y2={p2.y}
                    stroke={stroke}
                    strokeWidth={status === "err" ? 1.8 : 1.2}
                    opacity={0.9}
                  />
                  <g transform={`translate(${mx}, ${my})`}>
                    <rect
                      x={-38}
                      y={-9}
                      width={76}
                      height={18}
                      rx={3}
                      fill="var(--color-bg)"
                      stroke="var(--color-line)"
                      strokeWidth={0.5}
                    />
                    <text
                      textAnchor="middle"
                      y={-0.5}
                      fill={status === "err" ? "var(--color-err)" : "var(--color-mid)"}
                      fontSize={8.5}
                      fontFamily="var(--font-jetbrains)"
                    >
                      {perMin(e.callsPerMin)}
                    </text>
                    <text
                      textAnchor="middle"
                      y={7.5}
                      fill={status === "ok" ? "var(--color-faint)" : statusColor[status]}
                      fontSize={7.5}
                      fontFamily="var(--font-jetbrains)"
                    >
                      {e.errorPct.toFixed(1)}% err
                    </text>
                  </g>
                </g>
              );
            })}

            {/* nodes */}
            {nodes.map((n) => {
              const at = layout.positions.get(n.service);
              if (!at) return null;
              const status = topologyStatus(n.errorPct);
              return (
                <a
                  key={n.service}
                  href={`${TRACES_PATH}?service=${encodeURIComponent(n.service)}&range=${WINDOW_HOURS}h`}
                  aria-label={`${n.service} — ${n.spans.toLocaleString("en-US")} spans, ${n.errorPct.toFixed(1)}% errors, p95 ${fmtMs(n.p95Ms)}${n.isEntry ? ", entry point" : ""}`}
                >
                  <g transform={`translate(${at.x}, ${at.y})`}>
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={7}
                      fill="var(--color-raised)"
                      stroke={status === "ok" ? "var(--color-line-strong)" : statusColor[status]}
                      strokeWidth={status === "ok" ? 1 : 1.4}
                    />
                    <rect x={0} y={8} width={3} height={NODE_H - 16} rx={1.5} fill={layerColor[n.layer]} />
                    <circle cx={NODE_W - 12} cy={12} r={3} fill={statusColor[status]} />
                    <text
                      x={12}
                      y={20}
                      fill="var(--color-ink)"
                      fontSize={11.5}
                      fontWeight={600}
                      fontFamily="var(--font-jetbrains)"
                    >
                      {clip(n.service, 22)}
                    </text>
                    <text x={12} y={34} fill="var(--color-faint)" fontSize={8.5} fontFamily="var(--font-jetbrains)">
                      {perMin(n.spansPerMin)} · p95 {fmtMs(n.p95Ms)}
                    </text>
                    <text
                      x={12}
                      y={46}
                      fill={status === "ok" ? "var(--color-faint)" : statusColor[status]}
                      fontSize={8.5}
                      fontFamily="var(--font-jetbrains)"
                    >
                      {n.errorPct.toFixed(1)}% err{n.isEntry ? " · entry" : ""}
                    </text>
                  </g>
                </a>
              );
            })}
          </svg>
        )}
      </div>

      <p className="mt-2 max-w-prose font-mono text-[10.5px] leading-relaxed text-faint">
        Built from the traces this workspace sent — no manual config. An edge is drawn only when
        BOTH spans are stored, so a service that sends no telemetry between two of these draws
        nothing at all. &ldquo;entry&rdquo; = the service has a span with no parent in this store.
        A node links to its traces.
      </p>
    </div>
  );
}
