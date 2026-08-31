"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Compass, X } from "lucide-react";

export const TOUR_EVENT = "obstack:start-tour";

interface TourStep {
  path: string;
  /** data-tour anchor to spotlight; card falls back to bottom-center if missing */
  target: string;
  title: string;
  body: string;
}

// The tour narrates surfaces in both modes, and most of the surfaces it walks
// still render sample data in live mode too — so a step may describe what a
// screen does, and may point at the demo incident as demo content, but it may
// not promise a capability the product does not have (D60/D63 class). Every
// claim below is present-tense true of the code in this repo.
const steps: TourStep[] = [
  {
    path: "/app",
    target: "overview-charts",
    title: "Overview — your system at a glance",
    body: "Requests, errors, latency and LLM cost in one place. The sample data has one story in it: a spike at 13:05 that shows up in every chart and on every screen of this tour. The dashed violet line beside it marks a deploy.",
  },
  {
    path: "/app",
    target: "watches",
    title: "Your watches",
    body: "Pin what you personally care about: a service, two services compared, a pod, a model's spend, a queue, a pipeline. “Add widget” composes one on the spot, and the layout is kept in this browser — it is not saved to your account.",
  },
  {
    path: "/app/map",
    target: "map",
    title: "The service map",
    body: "Topology drawn from trace data rather than from manual config, with traffic and error rates on the edges. In the sample data the red edge to the LLM provider is the 13:05 incident: 8.1% of calls returning 429. Click any node to drill in.",
  },
  {
    path: "/app/traces",
    target: "traces",
    title: "Traces — search everything",
    body: "Filter by status, duration, model or cost — and free-text search reaches inside prompts and log lines, not just span names. The colored dots show which layers each trace crossed.",
  },
  {
    path: "/app/traces/a3f8c1d92b6e407f",
    target: "trace-waterfall",
    title: "The unified trace — obstack's core",
    body: "One request, every layer: API span, agent steps, LLM calls with prompts inline, and the infra track below — in the sample data those diamonds are the pod being OOM-killed mid-completion. Live, “Explain this trace” appears on any failed trace: it reads that trace's own spans and logs, its evidence links back to them, and the summary arrives as the model writes it — each run counts against your plan's monthly Explain runs, and out of runs, or with no model configured, the panel says so instead of guessing. Here the explanation is the demo's, prepared. Flip waterfall → replay to read the run as a transcript.",
  },
  {
    // D60: this step annotates a LIVE-WIRED surface, so its words are a claim
    // about real data in live mode — capability only, true in both modes.
    // Nothing tails (D48) and no pod name is promised: the pod list is whatever
    // the workspace logged in the window.
    path: "/app/logs",
    target: "logs",
    title: "Logs — searched, filtered, joined",
    body: "Search log bodies, then narrow by severity, pod, time range or on-trace-only. The TRACE tag means the line belongs to a request; one click puts it back in context.",
  },
  {
    path: "/app/issues",
    target: "issues",
    title: "Issues — errors, grouped",
    body: "Recurring errors grouped by fingerprint with trends and an example trace each. The 429 group spiking in the last bucket? Same incident.",
  },
  {
    path: "/app/pipelines",
    target: "pipelines",
    title: "Pipelines — scheduled & event-driven flows",
    body: "Crons, Kafka consumers and one-off backfills, each with its run history. In the sample data it is a backfill that triggers the incident — its 41 failures link straight to their traces.",
  },
  {
    path: "/app/incidents",
    target: "incident",
    title: "Incidents — the story, stitched",
    // The source list is a capability claim even on a screen this step calls a
    // design: nothing ingests cluster events (`server/adapters.ts` sets none),
    // so they are not named among the sources (S4.4 R3 coordinator ruling).
    body: "The sample incident laid out end to end — pipelines, alerts, metrics and traces on one timeline, which is what the stitching is meant to show. This screen is a design, not a working incident tool: nothing here is generated from your data yet.",
  },
  {
    path: "/app/slos",
    target: "slos",
    title: "SLOs — error budgets",
    body: "Objectives with burn-down: chat latency is AT RISK because today burned 31% of the monthly budget in one afternoon. SLOs turn incidents into a number your team can manage.",
  },
  {
    path: "/app/costs",
    target: "costs",
    title: "Costs — AI unit economics",
    body: "Token cost joined to customers, features and models — the join obstack is built around. In the sample data Meridian costs $84/mo against $299 revenue, and draft_reply is 44% of spend.",
  },
  {
    path: "/app/users",
    target: "users",
    title: "Users — who felt it",
    body: "Failures grouped by the humans who experienced them. Meridian's ops account absorbed all 41 incident failures — that's a customer-success conversation, not just a graph.",
  },
  {
    path: "/app/connections",
    target: "connections",
    title: "Connections — every source plugs in",
    body: "Plain OTLP, Kubernetes and Docker connect today, each with copy-paste steps. Everything else on this page is marked coming soon — asking for one is a vote. If it writes a log, it belongs here.",
  },
  {
    path: "/app/mcp",
    target: "mcp",
    title: "MCP — your agents can read all of this",
    body: "The plan for reading obstack from an agent: a read-only MCP server your coding agent queries for traces, logs, incidents and SLOs. This screen shows the shape it will take — there is no server behind it yet.",
  },
  {
    path: "/app/ask",
    target: "ask",
    title: "Ask — and you're done",
    body: "Where plain-English questions will be answered from your telemetry, every claim linked to the evidence it came from. The answers on this screen are scripted for the demo. That's the tour — press ⌘K anytime to jump anywhere.",
  },
];

const CARD_W = 400;
const CARD_H_EST = 210;
const PAD = 12;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function TourGuide() {
  const [idx, setIdx] = useState<number | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const router = useRouter();
  const findTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const measure = useCallback((stepIdx: number, scroll: boolean) => {
    const el = document.querySelector<HTMLElement>(`[data-tour="${steps[stepIdx].target}"]`);
    if (!el) {
      setRect(null);
      return false;
    }
    if (scroll) el.scrollIntoView({ behavior: "smooth", block: "center" });
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    return true;
  }, []);

  /** after navigation, poll until the target exists, then keep tracking it */
  const trackStep = useCallback(
    (stepIdx: number) => {
      if (findTimer.current) clearInterval(findTimer.current);
      setRect(null);
      let tries = 0;
      let found = false;
      findTimer.current = setInterval(() => {
        tries += 1;
        const ok = measure(stepIdx, !found);
        if (ok) found = true;
        if (tries > 40 && !found) {
          if (findTimer.current) clearInterval(findTimer.current);
        }
      }, 150);
    },
    [measure],
  );

  useEffect(() => {
    const start = () => {
      router.push(steps[0].path);
      setIdx(0);
      trackStep(0);
    };
    window.addEventListener(TOUR_EVENT, start);
    return () => window.removeEventListener(TOUR_EVENT, start);
  }, [router, trackStep]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (idx !== null && e.key === "Escape") setIdx(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx]);

  useEffect(() => {
    if (idx === null && findTimer.current) clearInterval(findTimer.current);
  }, [idx]);

  // clear the tracker only on unmount
  useEffect(
    () => () => {
      if (findTimer.current) clearInterval(findTimer.current);
    },
    [],
  );

  if (idx === null) return null;
  const step = steps[idx];

  const go = (next: number) => {
    if (next < 0 || next >= steps.length) {
      setIdx(null);
      return;
    }
    router.push(steps[next].path);
    setIdx(next);
    trackStep(next);
  };

  /* card placement: below the target if it fits, else above, else bottom-center */
  let cardStyle: React.CSSProperties;
  if (rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.min(Math.max(rect.left, 16), Math.max(16, vw - CARD_W - 16));
    const below = rect.top + rect.height + PAD;
    const fitsBelow = below + CARD_H_EST < vh - 16;
    const above = rect.top - PAD - CARD_H_EST;
    cardStyle = fitsBelow
      ? { top: below, left }
      : above > 16
        ? { top: above, left }
        : { bottom: 16, left };
  } else {
    cardStyle = { bottom: 16, left: "50%", transform: "translateX(-50%)" };
  }

  return (
    <>
      {/* spotlight ring with dimmed backdrop cutout */}
      {rect && (
        <div
          className="pointer-events-none fixed z-40 rounded-xl transition-all duration-300"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            border: "2px solid color-mix(in srgb, var(--color-api) 80%, transparent)",
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55), 0 0 24px color-mix(in srgb, var(--color-api) 35%, transparent)",
          }}
        />
      )}

      <div className="fixed z-50 w-[400px] max-w-[calc(100vw-2rem)] transition-all duration-300" style={cardStyle}>
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
    </>
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
