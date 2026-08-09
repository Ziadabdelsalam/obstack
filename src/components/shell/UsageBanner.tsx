"use client";

import { useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { usage } from "@/mock/workspace";

export function UsageBanner() {
  const [dismissed, setDismissed] = useState(false);
  const pct = Math.round((usage.events.used / usage.events.quota) * 100);
  if (dismissed || pct < 70) return null;
  return (
    <div
      className="flex items-center gap-3 border-b px-4 py-1.5"
      style={{
        borderColor: "color-mix(in srgb, var(--color-warn) 30%, var(--color-line))",
        background: "color-mix(in srgb, var(--color-warn) 6%, transparent)",
      }}
    >
      <span className="font-mono text-[11px]" style={{ color: "var(--color-warn)" }}>
        {pct}% of free-tier events used
      </span>
      <span className="hidden font-mono text-[11px] text-faint sm:inline">
        resets {usage.resetsOn} · at 100% ingestion degrades to sampling, never a hard cut
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
