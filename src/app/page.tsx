import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";
import { HeroTrace } from "@/components/marketing/HeroTrace";
import { layerColor } from "@/lib/layers";
import { connectors } from "@/mock/connectors";

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
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5">
          <Wordmark />
          <nav className="hidden items-center gap-6 text-[13px] text-mid sm:flex">
            <a href="#product" className="hover:text-ink">Product</a>
            <a href="#connections" className="hover:text-ink">Connections</a>
            <a href="#pricing" className="hover:text-ink">Pricing</a>
          </nav>
          <Link
            href="/app"
            className="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-bg transition-transform hover:scale-[1.03]"
            style={{ background: "var(--color-ink)" }}
          >
            Open the demo
          </Link>
        </div>
      </header>

      {/* hero */}
      <section className="mx-auto max-w-6xl px-5 pt-16 pb-20 sm:pt-24">
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
              href="/app"
              className="flex items-center gap-2 rounded-md px-4.5 py-2.5 text-[14px] font-medium text-bg transition-transform hover:scale-[1.03]"
              style={{ background: "var(--color-ink)" }}
            >
              Open the live demo <ArrowRight className="h-4 w-4" />
            </Link>
            <span className="font-mono text-[12px] text-faint">
              OTel-native · one env var to try it
            </span>
          </div>
        </div>

        <div className="mt-12">
          <HeroTrace />
          <p className="mt-3 text-center font-mono text-[11px] text-faint">
            a real failure, joined: pod OOM-kill → truncated completion → failed agent step → 502
          </p>
        </div>
      </section>

      {/* problem */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-6xl px-5 py-16">
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
      <section id="product" className="mx-auto max-w-6xl px-5 py-16">
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
        <div className="mx-auto max-w-6xl px-5 py-16">
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

      {/* how it works */}
      <section className="mx-auto max-w-6xl px-5 py-16">
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
        <div className="mx-auto max-w-6xl px-5 py-16">
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
        <div className="mx-auto max-w-6xl px-5 py-14">
          <div className="flex flex-col items-start justify-between gap-6 sm:flex-row sm:items-center">
            <div>
              <h2 className="font-display text-[22px] font-semibold text-ink">
                See your whole stack in one trace.
              </h2>
              <p className="mt-1 text-[13.5px] text-mid">
                The demo is live sample data — no signup, no setup.
              </p>
            </div>
            <Link
              href="/app"
              className="flex items-center gap-2 rounded-md px-4.5 py-2.5 text-[14px] font-medium text-bg transition-transform hover:scale-[1.03]"
              style={{ background: "var(--color-ink)" }}
            >
              Open the live demo <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
            <Wordmark />
            <p className="font-mono text-[11px] text-faint">
              © 2026 obstack · prototype — all data on this site is fictional
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
