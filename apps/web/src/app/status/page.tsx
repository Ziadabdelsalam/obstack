import Link from "next/link";
import { Wordmark } from "@/components/shell/Wordmark";
import { mulberry32 } from "@/mock/rand";

/** Public status page — SLO-fed, incident history included. Demo of Loopwork's page. */

const components = [
  { name: "API", uptime90d: "99.97%", status: "operational" },
  { name: "Chat & agent replies", uptime90d: "99.89%", status: "operational" },
  { name: "Webhook ingestion", uptime90d: "99.99%", status: "operational" },
  { name: "Dashboard", uptime90d: "100%", status: "operational" },
];

function UptimeStrip({ seed, incidentAt }: { seed: number; incidentAt?: number }) {
  const rng = mulberry32(seed);
  const days = Array.from({ length: 90 }, (_, i) => {
    if (incidentAt !== undefined && i === incidentAt) return "partial";
    return rng() < 0.02 ? "degraded" : "ok";
  });
  return (
    <div className="flex items-end gap-[2px]" aria-hidden>
      {days.map((d, i) => (
        <span
          key={i}
          title={`day −${90 - i}`}
          className="h-6 w-[4px] rounded-[1px]"
          style={{
            background:
              d === "ok"
                ? "color-mix(in srgb, var(--color-ok) 70%, transparent)"
                : d === "partial"
                  ? "var(--color-warn)"
                  : "color-mix(in srgb, var(--color-warn) 45%, transparent)",
          }}
        />
      ))}
    </div>
  );
}

export default function StatusPage() {
  return (
    <div className="min-h-screen bg-bg">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-overlay font-mono text-[13px] font-bold text-ink">
              L
            </span>
            <div>
              <p className="text-[15px] font-semibold text-ink">Loopwork status</p>
              <p className="font-mono text-[10px] text-faint">status.loopwork.ai · powered by obstack SLOs</p>
            </div>
          </div>
          <Link href="/" aria-label="obstack">
            <Wordmark />
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-10">
        {/* overall */}
        <div
          className="flex items-center gap-3 rounded-xl border px-5 py-4"
          style={{
            borderColor: "color-mix(in srgb, var(--color-ok) 40%, var(--color-line))",
            background: "color-mix(in srgb, var(--color-ok) 5%, transparent)",
          }}
        >
          <span className="pulse-dot h-3 w-3 rounded-full" style={{ background: "var(--color-ok)" }} />
          <div>
            <p className="text-[16px] font-semibold text-ink">All systems operational</p>
            <p className="font-mono text-[11px] text-faint">
              recovered from a partial degradation earlier today (13:04–13:26 UTC)
            </p>
          </div>
        </div>

        {/* components */}
        <section className="mt-6 rounded-lg border border-line bg-surface">
          {components.map((c, i) => (
            <div key={c.name} className="border-b border-line/60 px-4 py-3.5 last:border-0">
              <div className="flex items-center justify-between">
                <p className="text-[13.5px] font-medium text-ink">{c.name}</p>
                <span className="flex items-center gap-2 font-mono text-[11px]" style={{ color: "var(--color-ok)" }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-ok)" }} />
                  operational
                </span>
              </div>
              <div className="mt-2 flex items-center gap-3">
                <UptimeStrip seed={100 + i} incidentAt={i <= 1 ? 89 : undefined} />
                <span className="shrink-0 font-mono text-[10.5px] text-faint">{c.uptime90d} · 90d</span>
              </div>
            </div>
          ))}
        </section>

        {/* incident history */}
        <section className="mt-8">
          <h2 className="mb-3 font-mono text-[11px] uppercase tracking-widest text-faint">
            incident history
          </h2>
          <div className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide"
                style={{
                  color: "var(--color-ok)",
                  background: "color-mix(in srgb, var(--color-ok) 12%, transparent)",
                }}
              >
                RESOLVED
              </span>
              <p className="text-[13.5px] font-medium text-ink">
                Elevated errors on bulk ticket operations
              </p>
              <span className="ml-auto font-mono text-[10.5px] text-faint">Aug 9 · 13:04–13:26 UTC</span>
            </div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-mid">
              A batch import triggered upstream rate limiting, causing failures for ~2% of requests
              on bulk endpoints for 22 minutes. Interactive conversations were not affected. We've
              capped retry behavior and isolated batch traffic to prevent recurrence.
            </p>
            <p className="mt-2 font-mono text-[10px] text-faint">
              published from INC-42 · impact and timeline sourced from obstack automatically
            </p>
          </div>
        </section>

        <p className="mt-8 text-center font-mono text-[10px] text-faint">
          demo page — this is what your customers would see, generated from your SLOs and incidents
        </p>
      </main>
    </div>
  );
}
