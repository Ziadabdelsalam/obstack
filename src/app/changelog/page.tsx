import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";

const entries = [
  {
    date: "Aug 10, 2026",
    tag: "new",
    title: "Service map, Issues, Incidents, SLOs & trace diff",
    body: "The map draws your topology from trace data with live error rates on every edge. Issues groups recurring errors by fingerprint. Incidents reconstructs an outage end-to-end from pipelines, alerts, K8s events and traces. SLOs track error-budget burn, and trace diff compares any two runs span by span.",
  },
  {
    date: "Aug 9, 2026",
    tag: "new",
    title: "Pipelines: crons, consumers and backfills with live progress",
    body: "Every scheduled or event-driven flow in one place — run history, next runs, success rates, and a live progress bar for in-flight backfills, with failures linked straight to their traces.",
  },
  {
    date: "Aug 9, 2026",
    tag: "new",
    title: "Customizable Overview",
    body: "Pin what you actually watch: services, service comparisons, routes, pods, models, tools, queues and pipelines as widgets on your dashboard.",
  },
  {
    date: "Aug 8, 2026",
    tag: "new",
    title: "Logs explorer with live tail",
    body: "Severity and pod filters, free-text search, and an on-trace-only toggle. Every correlated line is one click from its trace.",
  },
  {
    date: "Aug 6, 2026",
    tag: "improved",
    title: "Traces now carry the full pipeline",
    body: "Async continuation through queues: a webhook that returns 202 in 58ms keeps its trace alive through Kafka, the agent, the database and the notifier. Queue dwell is a span. Service boundaries are marked.",
  },
  {
    date: "Aug 4, 2026",
    tag: "improved",
    title: "Infra track in every waterfall",
    body: "Pods and Kubernetes events (OOM kills, restarts, throttling) render on the trace timeline, aligned with the spans they affected.",
  },
  {
    date: "Aug 1, 2026",
    tag: "new",
    title: "Explain this trace",
    body: "One click on a failed trace produces a root-cause summary built from the correlated spans and logs — with evidence, not vibes.",
  },
  {
    date: "Jul 28, 2026",
    tag: "new",
    title: "Connections hub",
    body: "Cloud, PaaS, containers, databases, LLM gateways and CI as guided connections. OTLP, Kubernetes, Docker, Vercel and AWS CloudWatch at launch.",
  },
];

const tagStyle: Record<string, { color: string }> = {
  new: { color: "var(--color-api)" },
  improved: { color: "var(--color-agent)" },
  fixed: { color: "var(--color-ok)" },
};

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-3.5">
          <Link href="/" aria-label="obstack home">
            <Wordmark />
          </Link>
          <Link
            href="/app"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            Open the demo <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-12">
        <h1 className="font-display text-[28px] font-bold text-ink">Changelog</h1>
        <p className="mt-1 text-[14px] text-mid">What shipped, when.</p>

        <div className="mt-8 border-l border-line-strong">
          {entries.map((e) => (
            <article key={e.title} className="relative pb-8 pl-7 last:pb-0">
              <span
                className="absolute top-1.5 -left-[5px] h-[9px] w-[9px] rounded-full border-2 border-bg"
                style={{ background: tagStyle[e.tag].color }}
              />
              <div className="flex flex-wrap items-center gap-2.5">
                <time className="font-mono text-[11px] text-faint">{e.date}</time>
                <span
                  className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide uppercase"
                  style={{
                    color: tagStyle[e.tag].color,
                    background: `color-mix(in srgb, ${tagStyle[e.tag].color} 12%, transparent)`,
                  }}
                >
                  {e.tag}
                </span>
              </div>
              <h2 className="mt-1.5 text-[16px] font-semibold text-ink">{e.title}</h2>
              <p className="mt-1 text-[13.5px] leading-relaxed text-mid">{e.body}</p>
            </article>
          ))}
        </div>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-8">
          <Wordmark />
          <p className="font-mono text-[11px] text-faint">© 2026 obstack</p>
        </div>
      </footer>
    </div>
  );
}
