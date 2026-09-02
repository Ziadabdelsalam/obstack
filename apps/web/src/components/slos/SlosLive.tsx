import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { NotificationChannelRow } from "@/lib/alert-types";
import { SLO_WINDOW_DAYS, formatSloObjective, formatSloTarget, type SloRow, type SloStatus } from "@/lib/slo-types";
import { parseTracesUrl, tracesHref, tracesSearchString } from "@/lib/traces-filter";
import { NewSloButton, SloControls } from "./SlosEditor";

/**
 * SLOs, live (S7.3 T5, D514): a SERVER component fed exclusively by
 * `server/slos.ts` (and the plan row, for the D507 clip note) through
 * `slos/page.tsx`. No `@/mock/` import anywhere in this file.
 *
 * Every number on a card is the EVALUATOR's (D510): attainment, the error
 * budget consumed, the status and when it last changed. Nothing here
 * computes — it renders what was measured, and says "no data" (D508) or
 * "not yet evaluated" where nothing was, never 100%.
 *
 * Absent rather than staged (D13, packet §0): the fixture's analyst note (a
 * sentence about a specific afternoon — v1 has no narrator), its
 * evals/pipelines objectives (M7), the IaC export (it narrates the fixture),
 * and any link to the public status page (D256/D324 — that page is
 * deliberately not fed by SLOs, and this sprint does not change that).
 *
 * The style table is this file's own copy: the mock page's `statusStyle`
 * cannot move without breaking its byte pin, and the VOCABULARY has one
 * definition (`SloStatus`); the styling may exist twice — with a fourth
 * entry here for the state the fixture never had.
 */
const statusStyle: Record<SloStatus, { color: string; label: string }> = {
  healthy: { color: "var(--color-ok)", label: "HEALTHY" },
  "at-risk": { color: "var(--color-warn)", label: "AT RISK" },
  breached: { color: "var(--color-err)", label: "BREACHED" },
  "no-data": { color: "var(--color-faint)", label: "NO DATA" },
};

/** ISO UTC → `YYYY-MM-DD HH:MM UTC`, the alerts feed's idiom. */
const clock = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;

/** A measured percentage, at most two decimals, trailing zeros trimmed — or a dash. */
const pct = (value: number | null): string =>
  value === null ? "—" : `${Number(value.toFixed(2))}%`;

/** The inspect link: the traces that make up the number, through the real
 *  filter vocabulary (`parseTracesUrl` accepts exactly what this builds). */
function inspectHref(slo: SloRow): string {
  const filters = parseTracesUrl({});
  filters.service = slo.indicator.service ?? "";
  if (slo.indicator.kind === "availability") filters.status = "error";
  else filters.minMs = slo.indicator.thresholdMs;
  return tracesHref(tracesSearchString(filters));
}

export function SlosLive({
  slos,
  channels,
  retentionDays,
  planName,
}: {
  slos: SloRow[];
  channels: NotificationChannelRow[];
  /** The workspace's plan retention, for the D507 clip note. */
  retentionDays: number;
  planName: string;
}) {
  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="font-display text-[19px] font-semibold text-ink">SLOs</h1>
        <NewSloButton channels={channels} />
      </div>

      {slos.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface p-6 text-center" data-tour="slos">
          <p className="font-mono text-[13px] text-mid">
            no SLOs yet — an objective is a target over your own traces, measured every few minutes
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2" data-tour="slos">
          {slos.map((s) => {
            const st = statusStyle[s.status];
            const windowDays = SLO_WINDOW_DAYS[s.window];
            const clipped = retentionDays < windowDays;
            const burned = s.budgetBurnedPct;
            const hot = burned !== null && burned >= 75;
            return (
              <section
                key={s.id}
                className="rounded-lg border bg-surface p-4"
                style={{
                  borderColor:
                    s.status === "healthy" || s.status === "no-data"
                      ? "var(--color-line)"
                      : `color-mix(in srgb, ${st.color} 40%, var(--color-line))`,
                  opacity: s.enabled ? 1 : 0.6,
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[14.5px] font-semibold text-ink">{s.name}</h2>
                  <span
                    className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                    style={{ color: st.color, background: `color-mix(in srgb, ${st.color} 12%, transparent)` }}
                  >
                    {st.label}
                  </span>
                  {!s.enabled && <span className="font-mono text-[9.5px] tracking-wide text-faint">DISABLED</span>}
                  <span className="ml-auto font-mono text-[10.5px] text-faint">
                    {s.window}
                    {clipped && ` · ${retentionDays}d retained on ${planName}`}
                  </span>
                </div>
                <p className="mt-1 font-mono text-[11.5px] text-mid">{formatSloObjective(s.indicator, s.target, s.window)}</p>

                <div className="mt-3 flex items-baseline gap-4">
                  <span className="font-mono text-[24px] font-medium text-ink">{pct(s.currentPct)}</span>
                  <span className="font-mono text-[11px] text-faint">target {formatSloTarget(s.target)}%</span>
                  {s.goodCount !== null && s.totalCount !== null && (
                    <span className="font-mono text-[11px] text-faint">
                      {s.goodCount.toLocaleString("en-US")} of {s.totalCount.toLocaleString("en-US")} traces good
                    </span>
                  )}
                </div>

                {/* error budget consumed — the bar is clamped at 100%, the number is not (D509) */}
                <div className="mt-2.5">
                  <div className="mb-1 flex justify-between font-mono text-[10px] text-faint">
                    <span>error budget consumed</span>
                    <span style={{ color: hot ? st.color : "var(--color-faint)" }}>{pct(burned)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-overlay">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${burned === null ? 0 : Math.min(100, burned)}%`,
                        background: hot ? st.color : "color-mix(in srgb, var(--color-api) 70%, transparent)",
                      }}
                    />
                  </div>
                </div>

                <p className="mt-2.5 font-mono text-[10px] text-faint">
                  {s.evaluatedAt ? `evaluated ${clock(s.evaluatedAt)}` : "not yet evaluated"}
                  {s.lastTransitionAt && ` · ${st.label.toLowerCase()} since ${clock(s.lastTransitionAt)}`}
                  {" · "}
                  {s.channelName ? `→ ${s.channelName}` : "no channel — computed only"}
                </p>

                <div className="mt-2 flex items-center justify-between gap-2">
                  <Link
                    href={inspectHref(s)}
                    className="inline-flex items-center gap-1 font-mono text-[11px] hover:underline"
                    style={{ color: "var(--color-api)" }}
                  >
                    inspect <ArrowUpRight className="h-3 w-3" />
                  </Link>
                  <SloControls slo={s} channels={channels} />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
