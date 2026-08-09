"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { allTraces, getTrace } from "@/mock/traces";
import { slowTrace } from "@/mock/stories";
import { fmtMs } from "@/lib/format";
import { layerColor } from "@/lib/layers";
import { LayerChip } from "@/components/ui/LayerChip";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Layer, Trace } from "@/mock/types";

interface DiffRow {
  name: string;
  layer: Layer;
  a: number | null; // total ms in trace A (summed across occurrences)
  aCount: number;
  b: number | null;
  bCount: number;
}

function rowsFor(a: Trace, b: Trace): DiffRow[] {
  const acc = new Map<string, DiffRow>();
  const add = (t: Trace, side: "a" | "b") => {
    for (const s of t.spans) {
      const key = s.name.replace(/ \(.*\)$/, ""); // fold "(fallback: …)" variants
      const row =
        acc.get(key) ?? { name: key, layer: s.layer, a: null, aCount: 0, b: null, bCount: 0 };
      row[side] = (row[side] ?? 0) + s.durationMs;
      row[side === "a" ? "aCount" : "bCount"] += 1;
      acc.set(key, row);
    }
  };
  add(a, "a");
  add(b, "b");
  return [...acc.values()].sort((x, y) => (y.a ?? 0) + (y.b ?? 0) - ((x.a ?? 0) + (x.b ?? 0)));
}

function TraceSummary({ t, label }: { t: Trace; label: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="font-mono text-[9.5px] uppercase tracking-widest text-faint">{label}</p>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12.5px] text-ink">{t.rootName}</span>
        <StatusPill status={t.status} />
      </div>
      <p className="mt-1 font-mono text-[11px] text-mid">
        {fmtMs(t.durationMs)} · {t.spanCount} spans · {t.services.length} services
      </p>
      <Link
        href={`/app/traces/${t.id}`}
        className="mt-1 inline-flex items-center gap-1 font-mono text-[10.5px] hover:underline"
        style={{ color: "var(--color-api)" }}
      >
        {t.id} <ArrowUpRight className="h-2.5 w-2.5" />
      </Link>
    </div>
  );
}

export function TraceDiff() {
  const params = useSearchParams();
  const defaultB = allTraces.find(
    (t) => t.rootName === slowTrace.rootName && t.status === "ok" && t.id !== slowTrace.id,
  );
  const [aId, setAId] = useState(params.get("a") ?? slowTrace.id);
  const [bId, setBId] = useState(params.get("b") ?? defaultB?.id ?? allTraces[0].id);

  const a = getTrace(aId) ?? slowTrace;
  const b = getTrace(bId) ?? allTraces[0];
  const rows = useMemo(() => rowsFor(a, b), [a, b]);
  const maxDur = Math.max(...rows.map((r) => Math.max(r.a ?? 0, r.b ?? 0)), 1);
  const totalDelta = a.durationMs - b.durationMs;

  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center gap-2">
        <Link href="/app/traces" className="flex items-center gap-1 text-[12px] text-faint hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> traces
        </Link>
        <span className="text-faint">/</span>
        <span className="font-mono text-[11px] text-faint">diff</span>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[19px] font-semibold text-ink">Trace diff</h1>
        <span
          className="font-mono text-[12px]"
          style={{ color: totalDelta > 0 ? "var(--color-err)" : "var(--color-ok)" }}
        >
          {totalDelta > 0 ? "+" : ""}
          {fmtMs(Math.abs(totalDelta))} total {totalDelta > 0 ? "slower" : "faster"}
        </span>
      </div>

      {/* selectors */}
      <div className="mb-3 grid gap-2 sm:grid-cols-2">
        {(["A", "B"] as const).map((side) => (
          <select
            key={side}
            value={side === "A" ? aId : bId}
            onChange={(e) => (side === "A" ? setAId(e.target.value) : setBId(e.target.value))}
            aria-label={`Trace ${side}`}
            className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-mid focus:border-line-strong focus:outline-none"
          >
            {allTraces.slice(0, 30).map((t) => (
              <option key={t.id} value={t.id}>
                {side}: {t.rootName} · {fmtMs(t.durationMs)} · {t.status} · {t.id.slice(0, 8)}
              </option>
            ))}
          </select>
        ))}
      </div>

      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        <TraceSummary t={a} label="trace a" />
        <TraceSummary t={b} label="trace b" />
      </div>

      {/* per-span comparison */}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-widest text-faint">
              <th className="py-2 pl-3 font-medium">span</th>
              <th className="py-2 font-medium">a / b</th>
              <th className="w-[90px] py-2 text-right font-medium">a</th>
              <th className="w-[90px] py-2 text-right font-medium">b</th>
              <th className="w-[110px] py-2 pr-3 text-right font-medium">delta</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const delta = r.a !== null && r.b !== null ? r.a - r.b : null;
              const onlyOne = r.a === null || r.b === null;
              return (
                <tr key={r.name} className="border-b border-line/50 last:border-0">
                  <td className="py-2 pl-3">
                    <span className="flex items-center gap-2">
                      <span className="max-w-[260px] truncate font-mono text-[12px] text-ink">{r.name}</span>
                      <LayerChip layer={r.layer} />
                      {r.aCount > 1 || r.bCount > 1 ? (
                        <span className="font-mono text-[9.5px] text-faint">
                          ×{r.aCount || "–"}/{r.bCount || "–"}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className="block space-y-[3px]">
                      {[r.a, r.b].map((v, i) => (
                        <span key={i} className="block h-[5px] rounded-[1px]" style={{
                          width: v === null ? "2px" : `${Math.max((v / maxDur) * 100, 1)}%`,
                          background: v === null ? "var(--color-overlay)" : i === 0 ? layerColor[r.layer] : `color-mix(in srgb, ${layerColor[r.layer]} 45%, transparent)`,
                        }} />
                      ))}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono text-[11.5px] text-mid">
                    {r.a === null ? "—" : fmtMs(r.a)}
                  </td>
                  <td className="py-2 text-right font-mono text-[11.5px] text-mid">
                    {r.b === null ? "—" : fmtMs(r.b)}
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-[11.5px]" style={{
                    color: onlyOne
                      ? "var(--color-faint)"
                      : delta! > 50
                        ? "var(--color-err)"
                        : delta! < -50
                          ? "var(--color-ok)"
                          : "var(--color-mid)",
                  }}>
                    {onlyOne ? (r.a === null ? "only in B" : "only in A") : `${delta! > 0 ? "+" : ""}${fmtMs(Math.abs(delta!))}${delta! < 0 ? " faster" : ""}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 font-mono text-[10.5px] text-faint">
        spans matched by name; repeated spans (retries) are summed — ×a/×b shows occurrence counts
      </p>
    </div>
  );
}
