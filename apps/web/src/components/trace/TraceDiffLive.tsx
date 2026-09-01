import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { fmtMs } from "@/lib/format";
import { layerColor } from "@/lib/layers";
import { DEFAULT_TRACE_RANGE } from "@/lib/traces-filter";
import { LayerChip } from "@/components/ui/LayerChip";
import { StatusPill } from "@/components/ui/StatusPill";
import type { Layer, Trace } from "@/lib/types";

/**
 * How many of the workspace's most recent traces the picker offers (D400). The
 * page slices with this constant and the caption counts what was rendered, so
 * the number is stated once and the surface never claims a row it left out.
 */
export const DIFF_PICKER_SIZE = 30;

/**
 * `DiffRow` and `rowsFor` are DUPLICATED from `TraceDiffMock.tsx`, deliberately
 * (D391): that file is a frozen client component and this one is a server
 * component, and a shared "smart" module between them is exactly the coupling
 * D367 refuses — the mock body has to stay movable-verbatim.
 */
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

/**
 * This surface's whole selection mechanism: a URL (D392). The live diff has no
 * client state and no `<select>` — a picker row is a link that replaces ONE
 * side and carries the other one forward.
 */
function diffHref(aId: string, bId: string): string {
  const params = new URLSearchParams();
  if (aId) params.set("a", aId);
  if (bId) params.set("b", bId);
  return `/app/traces/diff?${params.toString()}`;
}

function TraceSummary({ t, label, caption }: { t: Trace; label: string; caption?: string }) {
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
      {caption && <p className="mt-1 font-mono text-[10.5px] text-faint">{caption}</p>}
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

function EmptySlot({ label, note }: { label: string; note: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-3">
      <p className="font-mono text-[9.5px] uppercase tracking-widest text-faint">{label}</p>
      <p className="mt-1 font-mono text-[11.5px] text-mid">{note}</p>
    </div>
  );
}

/**
 * The diff over two REAL traces (D400): a server component fed the two resolved
 * traces and the picker's rows, never a query of its own and never a mock
 * corpus. Both sides are nullable because both come out of a URL:
 *
 * - `a` is null ONLY when the link named an id this workspace does not have —
 *   `page.tsx` defaults an absent `?a=` to the most recent trace, and a
 *   workspace with no recent trace at all lands on the empty state below. So
 *   "trace not found in this workspace" is true wherever it renders (D13).
 * - `b` is null when no second trace is picked yet, which is the state the
 *   trace-detail compare link arrives in.
 *
 * `aAutoPicked` (D416, amending D400): `page.tsx` sets this true exactly when
 * `?a=` was absent — the auto-pick above happened silently, and slot A must
 * say so rather than presenting the most recent trace as if it had been named.
 */
export function TraceDiffLive({
  a,
  b,
  recent,
  aAutoPicked,
}: {
  a: Trace | null;
  b: Trace | null;
  recent: Trace[];
  aAutoPicked: boolean;
}) {
  const rows = a && b ? rowsFor(a, b) : [];
  const maxDur = Math.max(...rows.map((r) => Math.max(r.a ?? 0, r.b ?? 0)), 1);
  const totalDelta = a && b ? a.durationMs - b.durationMs : null;

  const header = (
    <>
      <div className="mb-1 flex items-center gap-2">
        <Link href="/app/traces" className="flex items-center gap-1 text-[12px] text-faint hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" /> traces
        </Link>
        <span className="text-faint">/</span>
        <span className="font-mono text-[11px] text-faint">diff</span>
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[19px] font-semibold text-ink">Trace diff</h1>
        {totalDelta !== null && (
          <span
            className="font-mono text-[12px]"
            style={{ color: totalDelta > 0 ? "var(--color-err)" : "var(--color-ok)" }}
          >
            {totalDelta > 0 ? "+" : ""}
            {fmtMs(Math.abs(totalDelta))} total {totalDelta > 0 ? "slower" : "faster"}
          </span>
        )}
      </div>
    </>
  );

  // Nothing to pick from and nothing resolved: the honest empty state, not a
  // "not found" about an id nobody named.
  if (!a && recent.length === 0) {
    return (
      <div className="px-5 py-4">
        {header}
        <p className="font-mono text-[11.5px] text-mid">
          no trace has arrived in this workspace in the last {DEFAULT_TRACE_RANGE} — nothing to compare yet
        </p>
      </div>
    );
  }

  return (
    <div className="px-5 py-4">
      {header}

      <div className="mb-4 grid gap-2 sm:grid-cols-2">
        {a ? (
          <TraceSummary
            t={a}
            label="trace a"
            caption={aAutoPicked ? "most recent trace — pick another to compare" : undefined}
          />
        ) : (
          <EmptySlot label="trace a" note="trace not found in this workspace" />
        )}
        {b ? (
          <TraceSummary t={b} label="trace b" />
        ) : (
          <EmptySlot label="trace b" note="pick a second trace" />
        )}
      </div>

      {/* per-span comparison */}
      {a && b && (
        <>
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
        </>
      )}

      {/* the picker: the workspace's own recent traces, as links (D392) */}
      <div className="mt-4 rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <h2 className="font-mono text-[11px] uppercase tracking-widest text-faint">pick a trace</h2>
          <span className="font-mono text-[10.5px] text-faint">
            last {DEFAULT_TRACE_RANGE} · {recent.length} most recent
          </span>
        </div>
        <ul>
          {recent.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 border-b border-line/50 px-3 py-1.5 last:border-0"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="max-w-[280px] truncate font-mono text-[12px] text-ink">{t.rootName}</span>
                <StatusPill status={t.status} />
                <span className="font-mono text-[10.5px] text-faint">
                  {fmtMs(t.durationMs)} · {t.spanCount} spans · {t.id.slice(0, 8)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Link
                  href={diffHref(t.id, b?.id ?? "")}
                  className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-mid hover:border-line-strong hover:text-ink"
                >
                  as a
                </Link>
                <Link
                  href={diffHref(a?.id ?? "", t.id)}
                  className="rounded-[4px] border border-line px-1.5 py-0.5 font-mono text-[10.5px] text-mid hover:border-line-strong hover:text-ink"
                >
                  as b
                </Link>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
