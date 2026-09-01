"use client";

import { useRouter } from "next/navigation";
import { layerColor } from "@/lib/layers";
import type { Layer } from "@/lib/types";

interface Node {
  id: string;
  label: string;
  sub: string;
  layer: Layer;
  x: number;
  y: number;
  status: "ok" | "warn" | "err";
  href?: string;
  external?: boolean;
}

interface EdgeDef {
  from: string;
  to: string;
  rate: string;
  errPct: number;
}

const W = 132;
const H = 46;

const nodes: Node[] = [
  { id: "clients", label: "clients", sub: "web · webhooks", layer: "api", x: 40, y: 240, status: "ok", external: true },
  { id: "gateway", label: "gateway", sub: "2 pods", layer: "api", x: 230, y: 240, status: "ok", href: "/app/traces?q=gateway" },
  { id: "kafka", label: "kafka", sub: "ticket-events", layer: "infra", x: 420, y: 120, status: "ok", href: "/app/pipelines" },
  { id: "agent-worker", label: "agent-worker", sub: "3 pods · 3 restarts 1h", layer: "agent", x: 610, y: 240, status: "warn", href: "/app/traces?q=agent" },
  { id: "llm", label: "LLM provider", sub: "claude · external", layer: "llm", x: 610, y: 60, status: "err", href: "/app/traces?q=429&status=error", external: true },
  { id: "tools", label: "tools", sub: "1 pod", layer: "tool", x: 810, y: 240, status: "ok", href: "/app/traces?q=tools" },
  { id: "kb-service", label: "kb-service", sub: "reindexing", layer: "infra", x: 830, y: 110, status: "warn", href: "/app/traces/b7e2d94a1c8f5e30" },
  { id: "notifier", label: "notifier", sub: "1 pod", layer: "tool", x: 810, y: 400, status: "ok", href: "/app/traces/d8a1f5c47e92b013" },
  { id: "sync-worker", label: "sync-worker", sub: "kafka consumer", layer: "infra", x: 420, y: 400, status: "ok", href: "/app/traces?q=sync-tickets" },
  { id: "postgres", label: "postgres", sub: "primary", layer: "infra", x: 230, y: 430, status: "ok", href: "/app/logs?q=pg" },
  { id: "redis", label: "redis", sub: "cache", layer: "infra", x: 615, y: 470, status: "ok", href: "/app/logs?q=redis" },
];

const edges: EdgeDef[] = [
  { from: "clients", to: "gateway", rate: "812/min", errPct: 0.4 },
  { from: "gateway", to: "kafka", rate: "96/min", errPct: 0 },
  { from: "gateway", to: "agent-worker", rate: "118/min", errPct: 2.1 },
  { from: "gateway", to: "postgres", rate: "410/min", errPct: 0.1 },
  { from: "kafka", to: "agent-worker", rate: "84/min", errPct: 0 },
  { from: "kafka", to: "sync-worker", rate: "45/min", errPct: 0.8 },
  { from: "agent-worker", to: "llm", rate: "214/min", errPct: 8.1 },
  { from: "agent-worker", to: "tools", rate: "187/min", errPct: 1.9 },
  { from: "tools", to: "kb-service", rate: "92/min", errPct: 4.3 },
  { from: "agent-worker", to: "notifier", rate: "61/min", errPct: 0 },
  { from: "sync-worker", to: "postgres", rate: "45/min", errPct: 0.8 },
  { from: "sync-worker", to: "redis", rate: "40/min", errPct: 0 },
];

const statusColor = { ok: "var(--color-ok)", warn: "var(--color-warn)", err: "var(--color-err)" };

function center(n: Node) {
  return { cx: n.x + W / 2, cy: n.y + H / 2 };
}

/** point on the rect border toward the other node's center */
function anchor(n: Node, toward: { cx: number; cy: number }) {
  const { cx, cy } = center(n);
  const dx = toward.cx - cx;
  const dy = toward.cy - cy;
  const sx = dx === 0 ? Infinity : (W / 2) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (H / 2) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function ServiceMapMock() {
  const router = useRouter();
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-[19px] font-semibold text-ink">Service map</h1>
        <div className="flex items-center gap-4 font-mono text-[10.5px] text-faint">
          {(["ok", "warn", "err"] as const).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: statusColor[s] }} />
              {s === "ok" ? "healthy" : s === "warn" ? "degraded" : "erroring"}
            </span>
          ))}
          <span>edge = live traffic · click anything to drill in</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface" data-tour="map">
        <svg viewBox="0 0 1000 545" className="min-w-[820px]" role="img" aria-label="Service topology map">
          {/* edges */}
          {edges.map((e) => {
            const a = byId.get(e.from)!;
            const b = byId.get(e.to)!;
            const p1 = anchor(a, center(b));
            const p2 = anchor(b, center(a));
            const hot = e.errPct >= 5;
            const warm = e.errPct >= 3 && e.errPct < 5;
            const stroke = hot ? "var(--color-err)" : warm ? "var(--color-warn)" : "var(--color-line-strong)";
            const mx = (p1.x + p2.x) / 2;
            const my = (p1.y + p2.y) / 2;
            return (
              <g key={`${e.from}-${e.to}`}>
                <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={stroke} strokeWidth={hot ? 1.8 : 1.2} className="edge-flow" opacity={0.9} />
                <g transform={`translate(${mx}, ${my})`}>
                  <rect x={-34} y={-9} width={68} height={18} rx={3} fill="var(--color-bg)" stroke="var(--color-line)" strokeWidth={0.5} />
                  <text textAnchor="middle" y={-0.5} fill={hot ? "var(--color-err)" : "var(--color-mid)"} fontSize={8.5} fontFamily="var(--font-jetbrains)">
                    {e.rate}
                  </text>
                  <text textAnchor="middle" y={7.5} fill={hot ? "var(--color-err)" : warm ? "var(--color-warn)" : "var(--color-faint)"} fontSize={7.5} fontFamily="var(--font-jetbrains)">
                    {e.errPct}% err
                  </text>
                </g>
              </g>
            );
          })}

          {/* nodes */}
          {nodes.map((n) => (
            <g
              key={n.id}
              transform={`translate(${n.x}, ${n.y})`}
              onClick={() => n.href && router.push(n.href)}
              style={{ cursor: n.href ? "pointer" : "default" }}
              role={n.href ? "link" : undefined}
              aria-label={`${n.label} — ${n.sub}`}
            >
              <rect
                width={W}
                height={H}
                rx={7}
                fill="var(--color-raised)"
                stroke={n.status === "ok" ? "var(--color-line-strong)" : statusColor[n.status]}
                strokeWidth={n.status === "ok" ? 1 : 1.4}
                strokeDasharray={n.external ? "4 3" : undefined}
              />
              <rect x={0} y={8} width={3} height={H - 16} rx={1.5} fill={layerColor[n.layer]} />
              <circle cx={W - 12} cy={12} r={3} fill={statusColor[n.status]}>
                {n.status !== "ok" && (
                  <animate attributeName="opacity" values="1;0.3;1" dur="2s" repeatCount="indefinite" />
                )}
              </circle>
              <text x={12} y={20} fill="var(--color-ink)" fontSize={11.5} fontWeight={600} fontFamily="var(--font-jetbrains)">
                {n.label}
              </text>
              <text x={12} y={34} fill={n.status === "warn" ? "var(--color-warn)" : "var(--color-faint)"} fontSize={8.5} fontFamily="var(--font-jetbrains)">
                {n.sub}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <p className="mt-2 font-mono text-[10.5px] text-faint">
        built from trace topology — no manual config. The red edge is today&apos;s incident: 8.1% of
        LLM calls returning 429.
      </p>
    </div>
  );
}
