import Link from "next/link";
import { ArrowUpRight, CalendarClock, Play, Zap } from "lucide-react";
import { pipelines, type RunStatus } from "@/mock/pipelines";

const statusColor: Record<RunStatus, string> = {
  success: "var(--color-ok)",
  failed: "var(--color-err)",
  running: "var(--color-api)",
  degraded: "var(--color-warn)",
};

const triggerIcon = { cron: CalendarClock, event: Zap, manual: Play } as const;

function fmtDur(s: number): string {
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  if (s < 90) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export default function PipelinesPage() {
  const running = pipelines.filter((p) => p.current);
  const rest = pipelines.filter((p) => !p.current);

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Pipelines</h1>
        <span className="font-mono text-[11px] text-faint">
          {pipelines.length} flows · crons, consumers & backfills
        </span>
      </div>

      {/* running now */}
      {running.map((p) => {
        const c = p.current!;
        return (
          <section
            key={p.slug}
            className="mb-5 rounded-lg border bg-surface p-4"
            style={{ borderColor: "color-mix(in srgb, var(--color-api) 40%, var(--color-line))" }}
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: "var(--color-api)" }} />
              <h2 className="font-mono text-[14px] font-medium text-ink">{p.name}</h2>
              <span
                className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                style={{
                  color: "var(--color-api)",
                  background: "color-mix(in srgb, var(--color-api) 12%, transparent)",
                }}
              >
                RUNNING
              </span>
              <span className="font-mono text-[11px] text-faint">
                started {c.startedAt} · {c.eta}
              </span>
              <span className="ml-auto font-mono text-[12px] text-ink">{c.progressPct}%</span>
            </div>
            <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-overlay">
              <div
                className="h-full rounded-full transition-[width]"
                style={{ width: `${c.progressPct}%`, background: "var(--color-api)" }}
              />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
              <span className="font-mono text-[11.5px] text-mid">
                {c.processed.toLocaleString()} / {c.total.toLocaleString()} processed
              </span>
              <span className="font-mono text-[11.5px]" style={{ color: c.failed ? "var(--color-warn)" : "var(--color-mid)" }}>
                {c.failed} failed
              </span>
              <span className="font-mono text-[11px] text-faint">{p.description}</span>
              {c.failLink && (
                <Link
                  href={c.failLink}
                  className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                  style={{ color: "var(--color-warn)" }}
                >
                  view failing traces <ArrowUpRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          </section>
        );
      })}

      {/* all pipelines */}
      <div className="space-y-2.5">
        {rest.map((p) => {
          const Icon = triggerIcon[p.triggerKind];
          const latest = p.runs[0];
          return (
            <section key={p.slug} className="rounded-lg border border-line bg-surface p-3.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <h2 className="font-mono text-[13.5px] font-medium text-ink">{p.name}</h2>
                <span className="flex items-center gap-1.5 rounded-[4px] border border-line bg-raised px-1.5 py-0.5 font-mono text-[10px] text-mid">
                  <Icon className="h-3 w-3 text-faint" />
                  {p.trigger}
                </span>
                <span className="font-mono text-[10.5px] text-faint">{p.service}</span>

                {/* run history dots */}
                <span className="ml-auto flex items-center gap-1" aria-label="recent runs">
                  {[...p.runs].reverse().map((r, i) => (
                    <span
                      key={i}
                      title={`${r.status} · ${fmtDur(r.durationS)} · ${r.at}${r.note ? ` — ${r.note}` : ""}`}
                      className="h-3 w-1.5 cursor-help rounded-[1px]"
                      style={{ background: statusColor[r.status], opacity: 0.4 + (0.6 * (i + 1)) / p.runs.length }}
                    />
                  ))}
                </span>
              </div>

              <p className="mt-1 text-[12.5px] text-mid">{p.description}</p>

              <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[9.5px] uppercase tracking-wider text-faint">last run</span>
                  <span className="font-mono text-[11.5px]" style={{ color: statusColor[latest.status] }}>
                    {latest.status}
                  </span>
                  <span className="font-mono text-[11.5px] text-mid">
                    · {fmtDur(latest.durationS)} · {latest.at}
                  </span>
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[9.5px] uppercase tracking-wider text-faint">next</span>
                  <span className="font-mono text-[11.5px] text-mid">{p.nextRun}</span>
                </span>
                <span className="flex items-baseline gap-1.5">
                  <span className="font-mono text-[9.5px] uppercase tracking-wider text-faint">success</span>
                  <span className="font-mono text-[11.5px] text-mid">{p.successRate}</span>
                </span>
                {latest.traceId && (
                  <Link
                    href={`/app/traces/${latest.traceId}`}
                    className="inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                    style={{ color: "var(--color-api)" }}
                  >
                    latest run trace <ArrowUpRight className="h-3 w-3" />
                  </Link>
                )}
              </div>

              {latest.note && (
                <p
                  className="mt-2 rounded-md border px-2.5 py-1.5 font-mono text-[11px] leading-snug"
                  style={{
                    color: latest.status === "degraded" || latest.status === "failed" ? "var(--color-warn)" : "var(--color-mid)",
                    borderColor: "var(--color-line)",
                    background: "var(--color-raised)",
                  }}
                >
                  {latest.note}
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
