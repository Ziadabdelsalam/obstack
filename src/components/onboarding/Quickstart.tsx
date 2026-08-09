"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy } from "lucide-react";
import { allTraces } from "@/mock/traces";
import { fmtMs, fmtTokens } from "@/lib/format";
import { StatusPill } from "@/components/ui/StatusPill";

const tabs = [
  {
    id: "python",
    label: "Python",
    code: `pip install obstack

# app.py
import obstack
obstack.init(api_key="ob_live_9f2e…")  # that's it — OTel underneath

# LLM + agent calls are captured automatically
from obstack import trace_agent

@trace_agent("support-agent")
def handle_ticket(ticket):
    ...`,
  },
  {
    id: "typescript",
    label: "TypeScript",
    code: `npm install obstack

// instrumentation.ts
import { init, traceAgent } from "obstack";
init({ apiKey: "ob_live_9f2e…" }); // that's it — OTel underneath

// LLM + agent calls are captured automatically
export const handleTicket = traceAgent("support-agent", async (ticket) => {
  ...
});`,
  },
  {
    id: "otel",
    label: "I already have OTel",
    code: `# no SDK, no code change — point your exporter at obstack
OTEL_EXPORTER_OTLP_ENDPOINT="https://ingest.obstack.dev"
OTEL_EXPORTER_OTLP_HEADERS="x-obstack-key=ob_live_9f2e…"`,
  },
];

export function Quickstart() {
  const [tab, setTab] = useState("python");
  const [copied, setCopied] = useState(false);
  const [arrived, setArrived] = useState(false);

  const firstTrace = allTraces.find((t) => t.status === "ok" && t.totalTokens > 0)!;

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = setTimeout(() => setArrived(true), reduced ? 0 : 5000);
    return () => clearTimeout(id);
  }, []);

  const active = tabs.find((t) => t.id === tab)!;
  const copy = () => {
    navigator.clipboard.writeText(active.code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="mx-auto max-w-2xl px-5 py-8">
      <h1 className="font-display text-[22px] font-semibold text-ink">
        Get your first trace
      </h1>
      <p className="mt-1 text-[13.5px] text-mid">
        Median time from here to a correlated trace: under 15 minutes. Your API key is
        already in the snippets.
      </p>

      {/* tabs */}
      <div className="mt-5 flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`-mb-px rounded-t-md border-b-2 px-3.5 py-2 text-[13px] transition-colors ${
              tab === t.id
                ? "border-current text-ink"
                : "border-transparent text-faint hover:text-mid"
            }`}
            style={tab === t.id ? { borderBottomColor: "var(--color-api)" } : undefined}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="group relative rounded-b-lg border border-t-0 border-line bg-surface">
        <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-relaxed text-mid">
          {active.code}
        </pre>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy snippet"
          className="absolute top-3 right-3 rounded border border-line bg-raised p-1.5 text-faint hover:text-ink"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5" style={{ color: "var(--color-ok)" }} />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      <p className="mt-3 text-[12.5px] text-faint">
        Shipping on Docker or Kubernetes? Add the{" "}
        <Link href="/app/connections" className="text-mid underline decoration-line underline-offset-2 hover:text-ink">
          collector
        </Link>{" "}
        too — that&apos;s what joins container logs to these traces.
      </p>

      {/* waiting → first trace */}
      <div className="mt-6 rounded-lg border border-line bg-surface p-4">
        {!arrived ? (
          <div className="flex items-center gap-3 py-3">
            <span className="pulse-dot h-2 w-2 rounded-full" style={{ background: "var(--color-warn)" }} />
            <span className="font-mono text-[12.5px] text-mid">
              waiting for data<span className="pulse-dot">…</span>
            </span>
            <span className="ml-auto font-mono text-[11px] text-faint">
              listening on ingest.obstack.dev
            </span>
          </div>
        ) : (
          <div className="fade-up">
            <p className="mb-2 flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-ok)" }}>
              <Check className="h-3.5 w-3.5" /> first trace received
            </p>
            <Link
              href={`/app/traces/${firstTrace.id}`}
              className="flex items-center justify-between rounded-md border border-line bg-raised px-3 py-2.5 transition-colors hover:border-line-strong"
            >
              <span className="flex min-w-0 items-center gap-3">
                <StatusPill status={firstTrace.status} />
                <span className="truncate font-mono text-[12.5px] text-ink">
                  {firstTrace.rootName}
                </span>
              </span>
              <span className="flex items-center gap-3 font-mono text-[11px] text-mid">
                {fmtMs(firstTrace.durationMs)} · {fmtTokens(firstTrace.totalTokens)} tok
                <ArrowRight className="h-3.5 w-3.5" style={{ color: "var(--color-api)" }} />
              </span>
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
