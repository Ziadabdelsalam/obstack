"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Search, ArrowUpRight } from "lucide-react";
import { podOptions, streamLogs } from "@/mock/logstream";
import { NOW } from "@/mock/generate";
import type { Severity } from "@/mock/types";

const sevColor: Record<Severity, string> = {
  debug: "var(--color-faint)",
  info: "var(--color-mid)",
  warn: "var(--color-warn)",
  error: "var(--color-err)",
  fatal: "var(--color-err)",
};

const sevRank: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3, fatal: 4 };

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}

function ago(ts: number): string {
  const m = Math.floor((NOW - ts) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

export function LogsExplorer() {
  const [q, setQ] = useState("");
  const [minSev, setMinSev] = useState<Severity>("debug");
  const [pod, setPod] = useState("all");
  const [correlated, setCorrelated] = useState(false);

  const results = useMemo(
    () =>
      streamLogs
        .filter(
          (l) =>
            sevRank[l.severity] >= sevRank[minSev] &&
            (pod === "all" || l.pod === pod) &&
            (!correlated || l.traceId) &&
            (!q ||
              l.body.toLowerCase().includes(q.toLowerCase()) ||
              l.pod.toLowerCase().includes(q.toLowerCase())),
        )
        .slice(0, 200),
    [q, minSev, pod, correlated],
  );

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">Logs</h1>
        <span className="flex items-center gap-2 font-mono text-[11px] text-faint">
          <span className="pulse-dot inline-block h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-ok)" }} />
          live tail · {results.length} shown · last 6h
        </span>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search log bodies and pods…"
            className="w-full rounded-md border border-line bg-surface py-1.5 pr-3 pl-8 text-[13px] text-ink placeholder:text-faint focus:border-line-strong focus:outline-none"
          />
        </div>
        <select
          value={minSev}
          onChange={(e) => setMinSev(e.target.value as Severity)}
          aria-label="Minimum severity"
          className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value="debug">severity: all</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">error+</option>
        </select>
        <select
          value={pod}
          onChange={(e) => setPod(e.target.value)}
          aria-label="Pod filter"
          className="max-w-[220px] rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-mid focus:border-line-strong focus:outline-none"
        >
          <option value="all">pod: all</option>
          {podOptions.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setCorrelated((c) => !c)}
          className="rounded-md border px-2.5 py-1.5 font-mono text-[11px] transition-colors"
          style={{
            borderColor: correlated
              ? "color-mix(in srgb, var(--color-infra) 45%, var(--color-line))"
              : "var(--color-line)",
            color: correlated ? "var(--color-infra)" : "var(--color-mid)",
            background: correlated
              ? "color-mix(in srgb, var(--color-infra) 8%, transparent)"
              : "var(--color-surface)",
          }}
        >
          on-trace only
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-surface" data-tour="logs">
        <table className="w-full min-w-[860px] border-collapse">
          <tbody>
            {results.length === 0 && (
              <tr>
                <td className="px-3 py-10 text-center text-[13px] text-faint">
                  No log lines match. Loosen a filter or clear the search.
                </td>
              </tr>
            )}
            {results.map((l) => (
              <tr key={l.id} className="group border-b border-line/40 last:border-0 hover:bg-raised">
                <td className="w-[74px] py-[5px] pl-3 align-top font-mono text-[10.5px] text-faint">
                  {clock(l.ts)}
                </td>
                <td className="w-[46px] py-[5px] align-top">
                  <span
                    className="font-mono text-[10px] font-medium uppercase"
                    style={{ color: sevColor[l.severity], fontWeight: l.severity === "fatal" ? 700 : 500 }}
                  >
                    {l.severity}
                  </span>
                </td>
                <td className="py-[5px] pr-3 align-top font-mono text-[11.5px] leading-relaxed text-mid group-hover:text-ink">
                  {l.body}
                </td>
                <td className="w-[200px] py-[5px] pr-2 text-right align-top font-mono text-[10px] text-faint">
                  {l.pod}
                </td>
                <td className="w-[48px] py-[5px] pr-1 text-right align-top font-mono text-[10px] text-faint">
                  {ago(l.ts)}
                </td>
                <td className="w-[70px] py-[5px] pr-3 text-right align-top">
                  {l.traceId ? (
                    <Link
                      href={`/app/traces/${l.traceId}`}
                      className="inline-flex items-center gap-0.5 font-mono text-[9.5px] tracking-wide hover:underline"
                      style={{ color: "var(--color-infra)" }}
                    >
                      TRACE <ArrowUpRight className="h-2.5 w-2.5" />
                    </Link>
                  ) : (
                    <span className="font-mono text-[9.5px] text-faint/60">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
