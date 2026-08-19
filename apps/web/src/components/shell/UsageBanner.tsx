"use client";

import { useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";

/**
 * The shell's quota line, prop-fed and deliberately incurious about where its
 * numbers come from: the app layout reads them once per render — from
 * `server/usage.ts` in live mode, from the mock workspace in the demo — and
 * hands them down, because this is a client component and a client component
 * cannot sum a ledger.
 *
 * That indirection is the D171 one-definition rule holding by construction: the
 * banner and the Billing & usage tab print the same events-used number because
 * it is the same SUM from the same function, not two counts that agree by luck.
 * The e2e drive asserts the two are equal, and this file is why it can.
 */
export interface UsageBannerProps {
  /** The plan's name from the catalog — no tier is named in this file (D163). */
  planName: string;
  eventsUsed: number;
  eventQuota: number;
  /**
   * When the period rolls over, already formatted. A date formatted in a client
   * component is formatted in the server's timezone before hydration and the
   * visitor's after it, so the layout formats this one in UTC and sends a string.
   */
  resets: string;
}

/** Loud enough to matter, quiet enough to ignore: the banner appears from 70% on. */
const NOTICE_AT_PCT = 70;

/** The banner's numbers when it should show, or null when it should not. */
export interface UsageNotice {
  /** The percentage to print — rounded for display, never for the decision below. */
  pct: number;
  /**
   * AT the quota, not past it — the same comparison the tab and Go's over-quota
   * SELECT make (D163). Not clamped, because a workspace 33% over its plan should
   * be told that and not shown a tidy 100%.
   */
  overQuota: boolean;
}

/**
 * The whole show-or-not decision, pulled out of the component so it can be tested
 * without a DOM (D54(ii) — a `"use client"` component cannot be rendered under the
 * runner, but a pure function it calls can be imported and driven).
 *
 * Two honesty guards live here. A zero or absent quota is degenerate: dividing by
 * it is Infinity or NaN, not a percentage, so it suppresses rather than paint
 * "Infinity% used" or raise a false "sampling active" (B5-1). And the threshold is
 * compared against the UNROUNDED ratio: at 69.5% a rounded percentage reads 70 and
 * would raise the banner half a point early, so rounding is for the display alone
 * (B5-2).
 */
export function usageBannerNotice(eventsUsed: number, eventQuota: number): UsageNotice | null {
  if (!(eventQuota > 0)) return null;
  const ratio = eventsUsed / eventQuota;
  if (ratio * 100 < NOTICE_AT_PCT) return null;
  return { pct: Math.round(ratio * 100), overQuota: eventsUsed >= eventQuota };
}

export function UsageBanner({ planName, eventsUsed, eventQuota, resets }: UsageBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const notice = usageBannerNotice(eventsUsed, eventQuota);
  if (dismissed || !notice) return null;
  const { pct, overQuota } = notice;
  return (
    <div
      className="flex items-center gap-3 border-b px-4 py-1.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
        background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
      }}
    >
      <span className="font-mono text-[11px]" style={{ color: "var(--color-warn)" }}>
        {/* Grouped in en-US explicitly, for the same reason the layout formats
            the reset date there: this renders on the server before hydration and
            in the visitor's browser after it, and a bare `toLocaleString()`
            groups by whichever locale each runtime happens to hold. */}
        {pct}% of {planName}-tier events used · {eventsUsed.toLocaleString("en-US")} /{" "}
        {eventQuota.toLocaleString("en-US")}
      </span>
      {/* Over quota the copy states what is happening to telemetry RIGHT NOW,
          and states it the way ingestion actually behaves (D165): head sampling
          per trace, so a sampled-out trace is gone whole and a surviving one is
          still a complete correlated trace. Nothing here is ever cut off
          mid-trace, and the banner is the last place to imply otherwise. */}
      <span className="hidden font-mono text-[11px] text-faint sm:inline">
        {overQuota
          ? `sampling active now — a sampled-out trace drops whole, survivors stay complete · resets ${resets}`
          : `resets ${resets} · at 100% ingestion degrades to sampling, never a hard cut`}
      </span>
      <Link
        href="/app/settings"
        className="ml-auto font-mono text-[11px] text-mid underline decoration-line underline-offset-2 hover:text-ink"
      >
        upgrade
      </Link>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss usage banner"
        className="rounded p-0.5 text-faint hover:text-ink"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
