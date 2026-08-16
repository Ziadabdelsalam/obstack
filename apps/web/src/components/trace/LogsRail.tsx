"use client";

import type { LogRecord, Severity } from "@/lib/types";

const sevColor: Record<Severity, string> = {
  debug: "var(--color-faint)",
  info: "var(--color-mid)",
  warn: "var(--color-warn)",
  error: "var(--color-err)",
  fatal: "var(--color-err)",
};

function fmtOffset(ms: number): string {
  const sign = ms < 0 ? "−" : "+";
  const abs = Math.abs(ms);
  return `${sign}${(abs / 1000).toFixed(2)}s`;
}

export function LogsRail({ logs }: { logs: LogRecord[] }) {
  const sorted = [...logs].sort((a, b) => a.atMs - b.atMs);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse">
        <tbody>
          {sorted.map((l) => {
            const solid = Boolean(l.traceId);
            return (
              <tr key={l.id} className="group border-b border-line/50 last:border-0">
                <td className="w-[64px] py-[5px] pr-2 align-top font-mono text-[10.5px] text-faint">
                  {fmtOffset(l.atMs)}
                </td>
                <td className="w-[52px] py-[5px] pr-2 align-top">
                  <span
                    className="font-mono text-[10px] font-medium uppercase"
                    style={{ color: sevColor[l.severity], fontWeight: l.severity === "fatal" ? 700 : 500 }}
                  >
                    {l.severity}
                  </span>
                </td>
                <td className="py-[5px] pr-3 align-top">
                  <span
                    className="border-l-2 pl-2 font-mono text-[11.5px] leading-relaxed text-mid group-hover:text-ink"
                    style={{
                      borderColor: solid
                        ? "var(--color-infra)"
                        : "color-mix(in srgb, var(--color-infra) 30%, transparent)",
                      borderLeftStyle: solid ? "solid" : "dashed",
                    }}
                  >
                    {l.body}
                  </span>
                </td>
                <td className="w-[190px] py-[5px] pr-2 text-right align-top">
                  <span className="font-mono text-[10px] text-faint">
                    {l.pod}
                    {l.container !== "app" ? ` · ${l.container}` : ""}
                  </span>
                </td>
                <td className="w-[56px] py-[5px] text-right align-top">
                  {solid ? (
                    <span className="font-mono text-[9.5px] tracking-wide" style={{ color: "var(--color-infra)" }}>
                      TRACE
                    </span>
                  ) : (
                    <span className="font-mono text-[9.5px] tracking-wide text-faint">NEARBY</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
