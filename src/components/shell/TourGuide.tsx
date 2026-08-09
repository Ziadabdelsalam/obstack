"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Compass, X } from "lucide-react";

export const TOUR_EVENT = "obstack:start-tour";

interface TourStep {
  path: string;
  title: string;
  body: string;
}

const steps: TourStep[] = [
  {
    path: "/app",
    title: "Overview — your system at a glance",
    body: "Requests, errors, latency and LLM cost in one place. Notice the spike at 13:05 in every chart — that's a real incident in this demo, and every screen you'll see next tells part of its story. The dashed violet line is a deploy marker.",
  },
  {
    path: "/app",
    title: "Your watches",
    body: "Below the core charts, pin what you personally care about: a service, two services compared, a pod, a model's spend, a queue, a pipeline. Try “Add widget” later — your layout persists.",
  },
  {
    path: "/app/map",
    title: "The service map",
    body: "Your whole topology, drawn from trace data — no manual config. Edges show live traffic and error rates. The red edge to the LLM provider is the 13:05 incident: 8.1% of calls returning 429. Click any node to drill into its traces.",
  },
  {
    path: "/app/traces",
    title: "Traces — search everything",
    body: "Filter by status, duration, model or cost — and free-text search reaches inside prompts and log lines, not just span names. The colored dots show which layers each trace crossed.",
  },
  {
    path: "/app/traces/a3f8c1d92b6e407f",
    title: "The unified trace — obstack's core",
    body: "One request, every layer: the API span, agent steps, LLM calls with prompts inline, and the infra track below — those diamonds are the pod being OOM-killed mid-completion. Correlated logs sit underneath. Try “Explain this trace”, and flip the waterfall/replay toggle to read the agent run as a transcript.",
  },
  {
    path: "/app/logs",
    title: "Logs — live tail, joined",
    body: "Every pod's logs in one stream — app logs, kubelet, postgres, cert-manager. The green TRACE tag means that line belongs to a request; one click puts it back in context.",
  },
  {
    path: "/app/issues",
    title: "Issues — errors, grouped",
    body: "Recurring errors grouped by fingerprint with trends, first/last seen and an example trace each. The 429 group spiking in the last bucket? Same incident.",
  },
  {
    path: "/app/pipelines",
    title: "Pipelines — scheduled & event-driven flows",
    body: "Crons, Kafka consumers and one-off backfills with run history and live progress. The zendesk-migration backfill triggered today's incident — its 41 failures link straight to their traces.",
  },
  {
    path: "/app/incidents",
    title: "Incidents — the story, stitched",
    body: "The 13:05 incident reconstructed end to end: pipeline start, first 429s, alerts, queue saturation, the OOM kill, mitigation, resolution. Hit “Generate root-cause analysis” for a postmortem you can copy as markdown.",
  },
  {
    path: "/app/slos",
    title: "SLOs — error budgets",
    body: "Objectives with burn-down: chat latency is AT RISK because today burned 31% of the monthly budget in one afternoon. SLOs turn incidents into a number your team can manage.",
  },
  {
    path: "/app/costs",
    title: "Costs — AI unit economics",
    body: "Token cost joined to customers, features and models: Meridian Labs costs $84/mo against $299 revenue, and draft_reply is 44% of total spend. No other tool joins cost to traces to customers.",
  },
  {
    path: "/app/users",
    title: "Users — who felt it",
    body: "Failures grouped by the humans who experienced them. Meridian's ops account absorbed all 41 incident failures — that's a customer-success conversation, not just a graph.",
  },
  {
    path: "/app/connections",
    title: "Connections — every source plugs in",
    body: "Kubernetes, Docker, Vercel, CloudWatch and plain OTLP work today; the rest of the catalog shows what's coming — requesting a connector is a vote. If it writes a log, it belongs here.",
  },
  {
    path: "/app/mcp",
    title: "MCP — your agents can read all of this",
    body: "A read-only MCP server: Claude Code or Cursor can query traces, logs, incidents and SLOs themselves. Ask your agent “why did INC-42 happen?” and it pulls the evidence. Every call is audit-logged.",
  },
  {
    path: "/app/ask",
    title: "Ask — and you're done",
    body: "Plain-English questions answered from your telemetry, every claim linked to evidence. That's the tour — press ⌘K anytime to jump anywhere, and the Quickstart shows how real data gets in. Enjoy poking around.",
  },
];

export function TourGuide() {
  const [idx, setIdx] = useState<number | null>(null);
  const router = useRouter();

  useEffect(() => {
    const start = () => {
      setIdx(0);
      router.push(steps[0].path);
    };
    window.addEventListener(TOUR_EVENT, start);
    return () => window.removeEventListener(TOUR_EVENT, start);
  }, [router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (idx !== null && e.key === "Escape") setIdx(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx]);

  if (idx === null) return null;
  const step = steps[idx];

  const go = (next: number) => {
    if (next < 0 || next >= steps.length) {
      setIdx(null);
      return;
    }
    setIdx(next);
    router.push(steps[next].path);
  };

  return (
    <div className="fixed right-4 bottom-4 z-50 w-[400px] max-w-[calc(100vw-2rem)] fade-up">
      <div
        className="rounded-xl border bg-surface shadow-2xl"
        style={{ borderColor: "color-mix(in srgb, var(--color-api) 45%, var(--color-line))" }}
      >
        <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <span className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-widest" style={{ color: "var(--color-api)" }}>
            <Compass className="h-3.5 w-3.5" />
            tour · {idx + 1} / {steps.length}
          </span>
          <button
            type="button"
            onClick={() => setIdx(null)}
            aria-label="End tour"
            className="rounded p-1 text-faint hover:bg-overlay hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="px-4 py-3">
          <h3 className="text-[14.5px] font-semibold text-ink">{step.title}</h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-mid">{step.body}</p>
        </div>
        <div className="flex items-center justify-between border-t border-line px-3.5 py-2.5">
          <div className="flex items-center gap-1" aria-hidden>
            {steps.map((_, i) => (
              <span
                key={i}
                className="h-1 rounded-full transition-all"
                style={{
                  width: i === idx ? 14 : 5,
                  background: i <= idx ? "var(--color-api)" : "var(--color-line-strong)",
                }}
              />
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => go(idx - 1)}
              disabled={idx === 0}
              aria-label="Previous"
              className="rounded-md border border-line bg-raised p-1.5 text-mid hover:text-ink disabled:opacity-40"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => go(idx + 1)}
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium text-bg"
              style={{ background: "var(--color-ink)" }}
            >
              {idx === steps.length - 1 ? "Finish" : "Next"}
              {idx < steps.length - 1 && <ArrowRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function StartTourButton({ variant = "chip" }: { variant?: "chip" | "big" }) {
  const start = () => window.dispatchEvent(new Event(TOUR_EVENT));
  if (variant === "big") {
    return (
      <button
        type="button"
        onClick={start}
        className="flex items-center gap-2 rounded-md border px-3.5 py-2 text-[13px] font-medium transition-colors"
        style={{
          color: "var(--color-api)",
          borderColor: "color-mix(in srgb, var(--color-api) 45%, var(--color-line))",
          background: "color-mix(in srgb, var(--color-api) 7%, transparent)",
        }}
      >
        <Compass className="h-4 w-4" />
        Take the product tour
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={start}
      aria-label="Take the product tour"
      title="Take the product tour"
      className="rounded-md p-1.5 text-mid transition-colors hover:bg-raised hover:text-ink"
    >
      <Compass className="h-4 w-4" />
    </button>
  );
}
