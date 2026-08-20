import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";

/**
 * Every entry names something the product does when you run it (D229). The four
 * that announced surfaces which exist only as demo content — the service map,
 * Issues/Incidents/SLOs, trace diff, Pipelines, the customizable Overview, the
 * infra track — are deleted rather than softened: an entry with no true
 * referent has nothing to reword into. The rest were rewritten down to what
 * actually shipped, which is why the two-word streaming-tail claim the D60
 * sweep in `components/shell/TourGuide.test.ts` bans — never spelled here, so
 * that sweep now covers this file too (D246) — and the "at launch" Vercel and
 * CloudWatch claims are gone (the connections hub itself marks both
 * coming-soon, D208).
 */
const entries = [
  // Dated for the real ship, not the date the entry used to carry: Explain
  // exists as of today, so this is the one entry written the day its feature
  // landed (D229 rewrite-to-truth, D232's W4 follow-up).
  {
    date: "Aug 20, 2026",
    tag: "new",
    title: "Explain this trace",
    body: "One click on a failed trace streams a root-cause summary built from that trace's own spans and the log lines on its timeline — the ones carrying its trace id and the nearby lines from the same window. Each piece of evidence links back to the span or log line it came from, and a reference the trace does not contain is dropped, with the drop stated rather than linked. The summary comes from Claude, or from whichever Anthropic-compatible endpoint a self-hosted install is pointed at; with no model configured the panel says so instead of guessing. Runs are metered per plan — 20 a month on Free, 200 on Pro.",
  },
  {
    date: "Aug 8, 2026",
    tag: "new",
    title: "Logs explorer",
    body: "Search log bodies, and filter by minimum severity, pod and time range. Any line carrying a trace id is one click from its trace. Nothing tails: refreshing is a button.",
  },
  {
    date: "Aug 6, 2026",
    tag: "improved",
    title: "Traces carry their logs",
    body: "A trace opens as its spans across every service that took part, with the log lines that share its trace id on the same timeline — plus the nearby lines from the same window, marked as nearby rather than claimed as correlated.",
  },
  {
    date: "Jul 28, 2026",
    tag: "new",
    title: "Connections hub",
    body: "OpenTelemetry, Kubernetes and Docker as guided connections, each with the ingest health of the source it set up. The rest of the catalog is listed as coming soon, because that is what it is.",
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
