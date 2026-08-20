"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { allTraces } from "@/mock/traces";
import { fmtMs, fmtTokens } from "@/lib/format";
import { StatusPill } from "@/components/ui/StatusPill";
import { OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";

/**
 * The demo deployment's arrival panel — the whole of it, including the timer,
 * in the one module that reaches `@/mock/traces` (D217).
 *
 * It lives here rather than inside `Quickstart` because "live mode never renders
 * that branch" is a statement about a render, not about a bundle: the import
 * still sat in the live surface's module graph, one refactor away from being
 * reachable again, which is the S1 L2 / D125/D158 leak class. Now the mock-mode
 * caller — the onboarding page's `dataMode` branch — hands this panel to
 * `Quickstart`, and a live caller never names this file at all.
 *
 * The demo has no ingest to wait for, so the flip plays on a timer, exactly as
 * it always has (D125 protects the demo's DATA, and this is that data).
 */
export function DemoArrival() {
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = setTimeout(() => setArrived(true), reduced ? 0 : 5000);
    return () => clearTimeout(id);
  }, []);

  if (!arrived) {
    return (
      <div className="flex items-center gap-3 py-3">
        <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: "var(--color-warn)" }} />
        <span className="font-mono text-[12.5px] text-mid">
          waiting for data<span className="pulse-dot">…</span>
        </span>
        <span className="ml-auto font-mono text-[11px] text-faint">
          listening on {OTLP_HTTP_ENDPOINT}
        </span>
      </div>
    );
  }
  const trace = allTraces.find((t) => t.status === "ok" && t.totalTokens > 0)!;
  return (
    <div className="fade-up">
      <p className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-ok)" }}>
        <Check className="h-3.5 w-3.5" /> first trace received
      </p>
      <Link
        href={`/app/traces/${trace.id}`}
        className="flex items-center justify-between rounded-md border border-line bg-raised px-3 py-2.5 transition-colors hover:border-line-strong"
      >
        <span className="flex min-w-0 items-center gap-3">
          <StatusPill status={trace.status} />
          <span className="truncate font-mono text-[12.5px] text-ink">{trace.rootName}</span>
        </span>
        <span className="flex items-center gap-3 font-mono text-[11px] text-mid">
          {fmtMs(trace.durationMs)} · {fmtTokens(trace.totalTokens)} tok
          <ArrowRight className="h-3.5 w-3.5" style={{ color: "var(--color-api)" }} />
        </span>
      </Link>
    </div>
  );
}
