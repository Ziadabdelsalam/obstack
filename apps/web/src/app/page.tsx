import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";
import { HeroTrace } from "@/components/marketing/HeroTrace";
import { ScreensShowcase } from "@/components/marketing/ScreensShowcase";
import { SampleLabel } from "@/components/marketing/SampleLabel";
import { SAMPLE_COPY } from "@/components/marketing/sample-copy";
import { appHref } from "@/lib/app-href";
import { layerColor } from "@/lib/layers";
import { connectors } from "@/components/connections/connectors";

/**
 * What obstack does, as nine sentences a reader can check against the product.
 *
 * D325 - this used to be a comparison table: the same nine rows, plus two
 * columns of ticks and dashes headed "Infra APM (Datadog / Grafana)" and "LLM
 * obs tool (Langfuse / Helicone)". Eighteen cells of believed-but-never-measured
 * claims about four named vendors, at least one of them false on its face, on
 * the most public page this product has. Nothing measured them and nothing
 * could keep them true, so the columns are cut rather than hedged and the rows
 * stay as what they always were on obstack's side: a capability list.
 *
 * Three of the nine were false about obstack too and are repaired here - no
 * retry concept exists anywhere in the schema, cost has no feature dimension,
 * and Kubernetes events are set only by the mock generator
 * (`mock/generate.ts:69`), never by the real adapters.
 * `app/landing-fence.test.ts` sweeps this file for the phrasings that went.
 */
const capabilityRows: string[] = [
  "One trace across API, agents, LLM calls and pods",
  "Prompts & completions inline in the trace",
  "Container logs joined to the exact request",
  "Agent steps and tool calls as first-class spans",
  "Async queue hops inside the same trace",
  "Token cost attribution per request and model",
  // What the wire actually carries: `0001_spans.sql:34-37` and
  // `0002_logs.sql:23-25` give every span and log line pod, namespace and
  // container identity. Cluster events were never ingested at all.
  "Pod and container identity on every span and log line",
  // True as of this sprint, and verified against what ships rather than left
  // as the promise it used to be: Explain assembles a failed trace's spans and
  // its correlated logs into a structured summary whose evidence items link
  // back to the span or log line each one came from (D229/D232 — the row went
  // true only once the surface landed).
  "Root-cause explanation from correlated evidence",
  // `connectors.ts:83` is the count: endpoint, protocol, headers.
  "Three OTEL_* variables to try with existing OTel",
];

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
            {/* D257: the two surfaces a stranger most needs and could not reach
                from here - the documentation this build serves, and the page
                that says what is running. Both are real routes in this image. */}
            <Link href="/docs" className="hover:text-ink">Docs</Link>
            <Link href="/changelog" className="hover:text-ink">Changelog</Link>
            <Link href="/status" className="hover:text-ink">Status</Link>
          </nav>
          <div className="flex items-center gap-4">
            <Link href="/app" className="hidden text-[13px] text-mid hover:text-ink sm:block">
              Open the demo
            </Link>
            {/* D329/K13 — the one link on this page that must reach the RUNNING
                app rather than this deployment. On the D262 marketing host a
                relative `/signup` renders the honest "there is nothing to
                create here" page, which is a dead end for the button a stranger
                is most likely to press. `appHref` is empty-by-default, so this
                is the same relative path everywhere until S5 sets the origin. */}
            <Link
              href={appHref("/signup")}
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
              href={appHref("/signup")}
              className="flex items-center gap-2 rounded-md px-4.5 py-2.5 text-[14px] font-medium text-bg transition-transform hover:scale-[1.03]"
              style={{ background: "var(--color-ink)" }}
            >
              Create your workspace <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/app"
              className="rounded-md border border-line bg-raised px-4.5 py-2.5 text-[14px] font-medium text-ink hover:border-line-strong"
            >
              Open the demo
            </Link>
            <span className="font-mono text-[12px] text-faint">
              OTel-native · three env vars to try it
            </span>
          </div>
          {/* One product, in the present tense (D106/D140): signing up is
              obstack you run - the whole thing, today. The block that used to
              sit below this offered to take an email address for a hosted
              obstack that does not exist, and on this deployment had nowhere to
              write it either (D257/D327), so it is gone rather than reworded. */}
          <p className="mt-3.5 max-w-lg text-[13px] leading-relaxed text-mid">
            Signing up creates your workspace on an obstack you run — the one you
            started yourself. Issue an API key in settings, point your OpenTelemetry
            exporter at it, and those traces land in that workspace.
          </p>
        </div>

        {/* D326 - the sting animates a trace that never happened, and until
            this sprint the only thing on the page that said so was a footer line
            covering it, the hero trace and four screenshots at once. It is its
            own surface, so it carries its own label. */}
        <figure className="mt-12">
          <video
            src="/hero-sting.mp4"
            autoPlay
            muted
            loop
            playsInline
            aria-label="an animated illustration of a joined trace"
            className="mx-auto w-full max-w-[960px] rounded-xl border border-line"
          />
          <figcaption className="mx-auto mt-3 max-w-[960px] text-center">
            <SampleLabel>a scripted illustration — {SAMPLE_COPY}</SampleLabel>
          </figcaption>
        </figure>
      </section>

      {/* the joined trace */}
      <section className="mx-auto w-full max-w-[1400px] px-5 pb-16">
        {/* The caption lives inside the component (D326): the fabricated widget
            and the label that says it is fabricated are one thing now, and
            cannot be composed apart. */}
        <HeroTrace />
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
              body: "Kubernetes, Docker and any OpenTelemetry source today; the rest of the catalog is listed as coming soon.",
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
            If it speaks OTel, it plugs in today.
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
            Already on OpenTelemetry? You&apos;re three environment variables away.
          </p>
        </div>
      </section>

      {/* screens showcase */}
      <section className="mx-auto w-full max-w-[1400px] px-5 py-16">
        <SectionLabel>see it</SectionLabel>
        <h2 className="mb-8 max-w-2xl font-display text-[26px] leading-tight font-semibold text-ink">
          One trace across your whole stack — not a trace viewer bolted onto a log store.
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
          <div className="mt-8 overflow-hidden rounded-lg border border-line bg-raised">
            <p className="border-b border-line px-4 py-3 font-mono text-[12px] font-semibold text-ink">
              obstack
            </p>
            <ul>
              {capabilityRows.map((c) => (
                <li
                  key={c}
                  className="flex items-start gap-3 border-b border-line/60 px-4 py-2.5 last:border-0"
                >
                  <Check
                    className="mt-0.5 h-4 w-4 shrink-0"
                    style={{ color: "var(--color-ok)" }}
                    aria-hidden
                  />
                  <span className="text-[13px] text-mid">{c}</span>
                </li>
              ))}
            </ul>
          </div>

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
                  <li>· correlation holds only while labels match</li>
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
                    obstack — one telemetry store, one data model
                  </span>
                </div>
                <ul className="mt-4 space-y-1.5 font-mono text-[11px] leading-relaxed text-mid">
                  <li>· traces, logs and cost share one trace_id by construction</li>
                  <li>· correlation is the default, not a config file</li>
                  <li>· prompts, agent steps, tokens and cost are first-class columns</li>
                  <li>· three env vars to try · one compose file to self-host</li>
                </ul>
              </div>
            </div>
            <p className="mt-5 max-w-3xl text-[13.5px] leading-relaxed text-mid">
              A platform team can wire Grafana into something close — for the infra half. The AI
              half (agent runs, prompts, token cost) has no home in the LGTM data model, and the
              join between the halves is exactly what breaks. obstack is for teams who want the
              joined view without building it.
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
              title: "Point your OTel at your obstack",
              body: "Or add our two-line SDK for Python / TypeScript — installed from this repo today.",
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
          {/* Free and Pro are the two rows of the `plans` catalog, restated by
              hand — every number here is a column of it (D226: the landing stays
              copy, verified true at review, rather than reaching across the
              D106 fence into Postgres). Seats were never a column, so the seat
              lines are gone rather than invented. Scale has no catalog row and
              no product: it states intent and carries no specifics at all
              (D229). Self-hosted is different (D236) — running obstack yourself
              is what ships today; only the supported paid tier is unbuilt, so
              the planned label sits on the price, not on the tier. */}
          <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-mid">
            Free and Pro are the plans the product carries today, and you can
            self-host obstack today for nothing. Scale is what we intend to
            build — no numbers yet, because there is nothing behind it to quote.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {[
              {
                name: "Free",
                price: "$0",
                per: "",
                items: ["50k events/mo", "7-day retention", "20 Explain runs/mo"],
              },
              {
                name: "Pro",
                price: "$49",
                per: "/mo + usage",
                hot: true,
                items: ["1M events included", "30-day retention", "200 Explain runs/mo"],
              },
              {
                name: "Scale",
                price: "Planned",
                per: "",
                soon: true,
                // Two items, not three: a support commitment is not something
                // this product has anywhere to make (D325).
                items: ["Higher event volume", "Longer retention"],
              },
              {
                name: "Self-hosted",
                // The price is the paid tier's, and that is the only planned
                // part: the bullets are things you can do this afternoon —
                // the same obstack the hero says signing up runs, installed
                // from the chart in this repo (docs' helm path).
                price: "Planned",
                per: "",
                note: "A supported paid tier is planned.",
                items: [
                  "Self-host today — free, run it yourself",
                  "Your hardware, your data",
                  "helm install obstack deploy/helm/obstack",
                ],
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
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[14px] font-semibold text-ink">{t.name}</p>
                  {t.soon && (
                    <span
                      className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide uppercase text-faint"
                      style={{ background: "color-mix(in srgb, var(--color-line) 60%, transparent)" }}
                    >
                      not built yet
                    </span>
                  )}
                </div>
                <p className="mt-2 flex items-baseline gap-1">
                  <span
                    // "Planned" is not a price, so it never reads like one —
                    // true of Scale's whole tier and of Self-hosted's paid one.
                    className={`font-display text-[26px] font-bold ${t.price === "Planned" ? "text-faint" : "text-ink"}`}
                  >
                    {t.price}
                  </span>
                  <span className="font-mono text-[11px] text-faint">{t.per}</span>
                </p>
                {t.note && (
                  <p className="mt-1.5 text-[12px] leading-relaxed text-faint">{t.note}</p>
                )}
                <ul className="mt-4 space-y-2">
                  {t.items.map((i) => (
                    <li key={i} className="flex items-start gap-2 text-[12.5px] text-mid">
                      {/* A tick means "you get this"; a planned tier gets a
                          dash, so the list reads as intent, not inventory. */}
                      {t.soon ? (
                        <span className="mt-0.5 w-3.5 shrink-0 text-center font-mono text-faint">–</span>
                      ) : (
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-ok)" }} />
                      )}
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
              {/* "live sample data" contradicted itself: the demo is a fixed
                  sample corpus, and the only thing live about it is that it is
                  running. Say which of the two it is (D106). */}
              <p className="mt-1 text-[13.5px] text-mid">
                The demo runs on sample data — no signup, no setup.
              </p>
              <p className="mt-1 text-[13.5px] text-mid">
                Signing up creates your own workspace on an obstack you run.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href={appHref("/signup")}
                className="flex items-center gap-2 rounded-md px-4.5 py-2.5 text-[14px] font-medium text-bg transition-transform hover:scale-[1.03]"
                style={{ background: "var(--color-ink)" }}
              >
                Create your workspace <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                href="/app"
                className="rounded-md border border-line bg-raised px-4.5 py-2.5 text-[14px] font-medium text-ink hover:border-line-strong"
              >
                Open the demo
              </Link>
            </div>
          </div>
          <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-6">
            <Wordmark />
            <div className="flex flex-wrap items-center gap-5">
              <Link href="/docs" className="text-[12px] text-mid hover:text-ink">
                Docs
              </Link>
              <Link href="/changelog" className="text-[12px] text-mid hover:text-ink">
                Changelog
              </Link>
              <Link href="/status" className="text-[12px] text-mid hover:text-ink">
                Status
              </Link>
              {/* This line used to carry a clause calling the whole site a
                  prototype whose data is fictional, and it was - as the fence
                  found - the ONLY label over the hero trace, the hero video and
                  the four screenshots. It could only go once each of those
                  carried its own (D326/K9), which is what `SampleLabel` and the
                  invariant in `app/landing-fence.test.ts` now guarantee. */}
              <p className="font-mono text-[11px] text-faint">© 2026 obstack</p>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
