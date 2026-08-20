import Link from "next/link";
import { ArrowRight, Check, Minus, X } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";
import { HeroTrace } from "@/components/marketing/HeroTrace";
import { ScreensShowcase } from "@/components/marketing/ScreensShowcase";
import { WaitlistForm } from "@/components/marketing/WaitlistForm";
import { layerColor } from "@/lib/layers";
import { connectors } from "@/components/connections/connectors";

const comparisonRows: { capability: string; obstack: "yes" | "partial" | "no"; apm: "yes" | "partial" | "no"; llm: "yes" | "partial" | "no" }[] = [
  { capability: "One trace across API, agents, LLM calls and pods", obstack: "yes", apm: "no", llm: "no" },
  { capability: "Prompts & completions inline in the trace", obstack: "yes", apm: "no", llm: "yes" },
  { capability: "Container logs joined to the exact request", obstack: "yes", apm: "partial", llm: "no" },
  { capability: "Agent steps, tool calls & retries as first-class spans", obstack: "yes", apm: "no", llm: "partial" },
  { capability: "Async queue hops inside the same trace", obstack: "yes", apm: "partial", llm: "no" },
  { capability: "Token cost attribution per request & feature", obstack: "yes", apm: "no", llm: "yes" },
  { capability: "K8s events on the trace timeline", obstack: "yes", apm: "partial", llm: "no" },
  { capability: "Root-cause explanation from correlated evidence", obstack: "yes", apm: "no", llm: "no" },
  { capability: "One env var to try with existing OTel", obstack: "yes", apm: "partial", llm: "partial" },
];

function Mark({ v }: { v: "yes" | "partial" | "no" }) {
  if (v === "yes") return <Check className="mx-auto h-4 w-4" style={{ color: "var(--color-ok)" }} aria-label="yes" />;
  if (v === "partial") return <Minus className="mx-auto h-4 w-4" style={{ color: "var(--color-warn)" }} aria-label="partial" />;
  return <X className="mx-auto h-4 w-4 text-faint" aria-label="no" />;
}

const layers = [
  { key: "api", label: "API" },
  { key: "agent", label: "agents" },
  { key: "llm", label: "LLM calls" },
  { key: "infra", label: "infrastructure" },
] as const;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.2em] text-faint">
      {children}
    </p>
  );
}

export default function Landing() {
  return (
    <div className="min-h-screen bg-bg">
      {/* nav */}
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1400px] items-center justify-between px-5 py-3.5">
          <Wordmark />
          <nav className="hidden items-center gap-6 text-[13px] text-mid sm:flex">
            <a href="#product" className="hover:text-ink">Product</a>
            <a href="#connections" className="hover:text-ink">Connections</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
            <Link href="/changelog" className="hover:text-ink">Changelog</Link>
          </nav>
          <div className="flex items-center gap-4">
            <Link href="/app" className="hidden text-[13px] text-mid hover:text-ink sm:block">
              Open the demo
            </Link>
            <Link
              href="/signup"
              className="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-bg transition-transform hover:scale-[1.03]"
              style={{ background: "var(--color-ink)" }}
            >
              Create your workspace
            </Link>
          </div>
        </div>
      </header>

      {/* hero — fills the first viewport */}
      <section className="mx-auto flex min-h-[calc(100svh-57px)] w-full max-w-[1400px] flex-col justify-center px-5 pt-12 pb-16 sm:pt-14">
        <div className="max-w-3xl">
          <h1 className="font-display text-[clamp(2.2rem,6vw,3.6rem)] leading-[1.05] font-bold tracking-tight text-ink">
            Every layer.
            <br />
            One trace.
          </h1>
          <p className="mt-5 max-w-xl text-[16px] leading-relaxed text-mid">
            obstack shows AI teams the whole story of a request — across{" "}
            {layers.map((l, i) => (
              <span key={l.key}>
                <span className="font-medium" style={{ color: layerColor[l.key] }}>
                  {l.label}
                </span>
                {i < layers.length - 2 ? ", " : i === layers.length - 2 ? " and " : " "}
              </span>
            ))}
            — so the cause and the symptom finally share a screen.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="flex items-center gap-2 rounded-md px-4.5 py-2.5 text-[14px] font-medium text-bg transition-transform hover:scale-[1.03]"
              style={{ background: "var(--color-ink)" }}
            >
              Create your workspace <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/app"
              className="rounded-md border border-line bg-raised px-4.5 py-2.5 text-[14px] font-medium text-ink hover:border-line-strong"
            >
              Open the live demo
            </Link>
            <span className="font-mono text-[12px] text-faint">
              OTel-native · one env var to try it
            </span>
          </div>
          {/* The two calls to action are two different products, and the page
              says which is which (D106/D140): signing up is obstack you run —
              the whole thing, today — and the waitlist below is for the hosted
              one, which we do not run for anyone yet. Present tense only. */}
          <p className="mt-3.5 max-w-lg text-[13px] leading-relaxed text-mid">
            Signing up creates your workspace on an obstack you run — the one you
            started yourself. Issue an API key in settings, point your OpenTelemetry
            exporter at it, and those traces land in that workspace.
          </p>

          <div id="waitlist" className="mt-8 max-w-md">
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-faint">
              cloud is in private preview
            </p>
            <p className="mb-3 text-[13px] leading-relaxed text-mid">
              We don&apos;t host obstack for you yet. Leave your email and we&apos;ll
              write when we do.
            </p>
            <WaitlistForm />
          </div>
        </div>

        <div className="mt-12">
          <video
            src="/hero-sting.mp4"
            autoPlay
            muted
            loop
            playsInline
            className="mx-auto w-full max-w-[960px] rounded-xl border border-line"
          />
        </div>
      </section>

      {/* the joined trace */}
      <section className="mx-auto w-full max-w-[1400px] px-5 pb-16">
        <HeroTrace />
        <p className="mt-3 text-center font-mono text-[11px] text-faint">
          a real failure, joined: pod OOM-kill → truncated completion → failed agent step → 502
        </p>
      </section>

      {/* problem */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-16">
          <SectionLabel>the problem</SectionLabel>
          <h2 className="max-w-2xl font-display text-[26px] leading-tight font-semibold text-ink">
            Debugging an AI product today means six tabs and a guess.
          </h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {[
              {
                title: "LLM tool",
                body: "Prompts and tokens live in one product. It has never heard of your pods.",
              },
              {
                title: "Infra tool",
                body: "Dashboards know the pod died. They can't say which agent run it took down.",
              },
              {
                title: "kubectl logs",
                body: "The truth is in there somewhere — behind a timestamp you're squinting at.",
              },
            ].map((c) => (
              <div key={c.title} className="rounded-lg border border-line bg-raised p-4">
                <p className="font-mono text-[12px] text-faint">{c.title}</p>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-mid">{c.body}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 max-w-2xl text-[14px] leading-relaxed text-mid">
            The cause is in one layer, the symptom in another — and nothing joins them.
            obstack&apos;s answer is structural:{" "}
            <span className="text-ink">one trace across all of it</span>, correlated by
            OpenTelemetry trace context, with container logs joined to the exact request
            they belong to.
          </p>
        </div>
      </section>

      {/* product features */}
      <section id="product" className="mx-auto w-full max-w-[1400px] px-5 py-16">
        <SectionLabel>the product</SectionLabel>
        <div className="grid gap-10 md:grid-cols-3">
          {[
            {
              color: "var(--color-api)",
              title: "The unified trace view",
              body: "One waterfall: API span, agent steps, tool calls, LLM calls with full prompts inline — and the container logs from the same pods, on the same timeline.",
            },
            {
              color: "var(--color-infra)",
              title: "Connections for every source",
              body: "Cloud, PaaS, Kubernetes, databases, LLM gateways, CI — every place your system writes a log becomes a connection, not a silo.",
            },
            {
              color: "var(--color-llm)",
              title: "Explain this trace",
              body: "One click on a failed trace and obstack reads the correlated evidence — spans and logs together — and tells you what actually broke, with receipts.",
            },
          ].map((f) => (
            <div key={f.title}>
              <span className="mb-3 block h-1 w-8 rounded-full" style={{ background: f.color }} />
              <h3 className="text-[16px] font-semibold text-ink">{f.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-mid">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* connections wall */}
      <section id="connections" className="border-y border-line bg-surface">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-16">
          <SectionLabel>connections</SectionLabel>
          <h2 className="max-w-2xl font-display text-[26px] leading-tight font-semibold text-ink">
            If it writes a log, it plugs in.
          </h2>
          <div className="mt-8 flex flex-wrap gap-2">
            {connectors.map((c) => (
              <span
                key={c.slug}
                className="flex items-center gap-2 rounded-md border border-line bg-raised px-2.5 py-1.5"
              >
                <span className="font-mono text-[11px] font-semibold" style={{ color: c.markColor }}>
                  {c.mark}
                </span>
                <span className="text-[12px] text-mid">{c.name}</span>
                {c.status === "coming-soon" && (
                  <span className="font-mono text-[9px] tracking-wide text-faint">SOON</span>
                )}
              </span>
            ))}
          </div>
          <p className="mt-6 text-[13px] text-faint">
            Already on OpenTelemetry? You&apos;re one environment variable away.
          </p>
        </div>
      </section>

      {/* screens showcase */}
      <section className="mx-auto w-full max-w-[1400px] px-5 py-16">
        <SectionLabel>see it</SectionLabel>
        <h2 className="mb-8 max-w-2xl font-display text-[26px] leading-tight font-semibold text-ink">
          A full observability platform — not just a trace viewer.
        </h2>
        <ScreensShowcase />
      </section>

      {/* comparison */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-16">
          <SectionLabel>why not just stitch tools together?</SectionLabel>
          <h2 className="max-w-2xl font-display text-[26px] leading-tight font-semibold text-ink">
            The join is the product. You can&apos;t bolt it on.
          </h2>
          <div className="mt-8 overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[640px] border-collapse bg-raised">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="px-4 py-3 text-[12px] font-medium text-faint">Capability</th>
                  <th className="w-[120px] px-2 py-3 text-center">
                    <span className="font-mono text-[12px] font-semibold text-ink">obstack</span>
                  </th>
                  <th className="w-[140px] px-2 py-3 text-center text-[11px] font-medium text-faint">
                    Infra APM
                    <span className="block font-mono text-[9px]">Datadog · Grafana</span>
                  </th>
                  <th className="w-[140px] px-2 py-3 text-center text-[11px] font-medium text-faint">
                    LLM obs tool
                    <span className="block font-mono text-[9px]">Langfuse · Helicone</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((r) => (
                  <tr key={r.capability} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2.5 text-[13px] text-mid">{r.capability}</td>
                    <td className="px-2 py-2.5" style={{ background: "color-mix(in srgb, var(--color-api) 4%, transparent)" }}>
                      <Mark v={r.obstack} />
                    </td>
                    <td className="px-2 py-2.5"><Mark v={r.apm} /></td>
                    <td className="px-2 py-2.5"><Mark v={r.llm} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 font-mono text-[10.5px] text-faint">
            <Minus className="mr-1 inline h-3 w-3" style={{ color: "var(--color-warn)" }} />
            partial = possible with significant setup, or without cross-layer correlation
          </p>

          {/* assembled vs joined */}
          <div className="mt-12">
            <h3 className="font-display text-[20px] font-semibold text-ink">
              &ldquo;Can&apos;t I do this with Grafana?&rdquo; — assembled vs. joined.
            </h3>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-line bg-raised p-5">
                <p className="font-mono text-[11px] uppercase tracking-widest text-faint">
                  the assembled stack
                </p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {["Loki (logs)", "Tempo (traces)", "Mimir (metrics)", "Grafana (glue)"].map((b) => (
                    <span key={b} className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-mid">
                      {b}
                    </span>
                  ))}
                </div>
                <ul className="mt-4 space-y-1.5 font-mono text-[11px] leading-relaxed text-faint">
                  <li>· four backends to deploy, scale and upgrade</li>
                  <li>· correlation is configuration: derived fields, label matching, exemplars</li>
                  <li>· joins break silently when labels drift</li>
                  <li>· prompts, agents and tokens: not a concept</li>
                </ul>
              </div>
              <div
                className="rounded-lg border p-5"
                style={{
                  borderColor: "color-mix(in srgb, var(--color-api) 45%, var(--color-line))",
                  background: "color-mix(in srgb, var(--color-api) 4%, var(--color-raised))",
                }}
              >
                <p className="font-mono text-[11px] uppercase tracking-widest" style={{ color: "var(--color-api)" }}>
                  the joined store
                </p>
                <div className="mt-4">
                  <span className="rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-[11px] text-ink">
                    obstack — one store, one data model
                  </span>
                </div>
                <ul className="mt-4 space-y-1.5 font-mono text-[11px] leading-relaxed text-mid">
                  <li>· traces, logs, k8s events and cost share one trace_id by construction</li>
                  <li>· correlation is the default, not a config file</li>
                  <li>· prompts, agent steps, tokens and cost are first-class columns</li>
                  <li>· one env var to try · one container to self-host</li>
                </ul>
              </div>
            </div>
            <p className="mt-5 max-w-3xl text-[13.5px] leading-relaxed text-mid">
              A platform team can wire Grafana into something close — for the infra half. The AI
              half (agent runs, prompts, cost per customer, quality regressions) has no home in the
              LGTM data model, and the join between the halves is exactly what breaks. obstack is
              for teams who want the joined view without building it.
            </p>
          </div>
        </div>
      </section>

      {/* how it works */}
      <section className="mx-auto w-full max-w-[1400px] px-5 py-16">
        <SectionLabel>how it works</SectionLabel>
        <div className="grid gap-6 md:grid-cols-3">
          {[
            {
              n: "01",
              title: "Point your OTel at us",
              body: "Or add our 2-line SDK for Python / TypeScript with LLM and agent capture built in.",
            },
            {
              n: "02",
              title: "Drop the collector",
              body: "One DaemonSet or container ships Docker & Kubernetes logs with pod metadata attached.",
            },
            {
              n: "03",
              title: "Open one trace",
              body: "Requests, agent decisions, prompts, and the infra underneath — joined, searchable, explainable.",
            },
          ].map((s) => (
            <div key={s.n} className="rounded-lg border border-line bg-surface p-5">
              <p className="font-mono text-[12px] text-faint">{s.n}</p>
              <h3 className="mt-2 text-[15px] font-semibold text-ink">{s.title}</h3>
              <p className="mt-1.5 text-[13px] leading-relaxed text-mid">{s.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* pricing */}
      <section id="pricing" className="border-t border-line bg-surface">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-16">
          <SectionLabel>pricing</SectionLabel>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[
              {
                name: "Free",
                price: "$0",
                per: "",
                items: ["50k events/mo", "7-day retention", "2 seats", "20 Explain runs/mo"],
              },
              {
                name: "Pro",
                price: "$49",
                per: "/mo + usage",
                hot: true,
                items: ["1M events included", "30-day retention", "Unlimited seats", "200 Explain runs/mo"],
              },
              {
                name: "Scale",
                price: "Volume",
                per: "pricing",
                items: ["90-day retention", "Priority support", "Custom event volume", "Usage alerts"],
              },
              {
                name: "Self-hosted",
                price: "Annual",
                per: "license",
                items: ["Your hardware, your data", "Unlimited volume", "Same product as cloud", "For privacy-critical teams"],
              },
            ].map((t) => (
              <div
                key={t.name}
                className="rounded-lg border bg-raised p-5"
                style={{
                  borderColor: t.hot
                    ? "color-mix(in srgb, var(--color-api) 45%, var(--color-line))"
                    : "var(--color-line)",
                }}
              >
                <p className="text-[14px] font-semibold text-ink">{t.name}</p>
                <p className="mt-2 flex items-baseline gap-1">
                  <span className="font-display text-[26px] font-bold text-ink">{t.price}</span>
                  <span className="font-mono text-[11px] text-faint">{t.per}</span>
                </p>
                <ul className="mt-4 space-y-2">
                  {t.items.map((i) => (
                    <li key={i} className="flex items-start gap-2 text-[12.5px] text-mid">
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-ok)" }} />
                      {i}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA + footer */}
      <footer className="border-t border-line">
        <div className="mx-auto w-full max-w-[1400px] px-5 py-14">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-display text-[22px] font-semibold text-ink">
                See your whole stack in one trace.
              </h2>
              <p className="mt-1 text-[13.5px] text-mid">
                The demo is live sample data — no signup, no setup.
              </p>
              <p className="mt-1 text-[13.5px] text-mid">
                Signing up creates your own workspace on an obstack you run. The
                hosted one is in private preview:
              </p>
              <div className="mt-4">
                <WaitlistForm />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/signup"
                className="flex items-center gap-2 rounded-md px-4.5 py-2.5 text-[14px] font-medium text-bg transition-transform hover:scale-[1.03]"
                style={{ background: "var(--color-ink)" }}
              >
                Create your workspace <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/app"
                className="rounded-md border border-line bg-raised px-4.5 py-2.5 text-[14px] font-medium text-ink hover:border-line-strong"
              >
                Open the live demo
              </Link>
            </div>
          </div>
          <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
            <Wordmark />
            <div className="flex items-center gap-5">
              <Link href="/changelog" className="text-[12px] text-mid hover:text-ink">
                Changelog
              </Link>
              <p className="font-mono text-[11px] text-faint">
                © 2026 obstack · prototype — all data on this site is fictional
              </p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
