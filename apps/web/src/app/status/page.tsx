import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";
import { STATUS_COMPONENT_IDS, type IncidentStatus, type StatusComponentId } from "@/lib/docs/incidents";
import { loadIncidents } from "@/lib/docs/incidents-load";

/**
 * obstack's own status page (D256, shape ratified by D324).
 *
 * WHAT THIS PAGE REPLACED, and why none of it came back: the route used to
 * render a fictional customer's status page — a seeded-PRNG availability strip
 * over ninety days, four components carrying invented figures, an invented
 * resolved incident, and a header crediting the whole thing to an obstack
 * capability that does not exist (an SLO-fed public status page is M6's, if it
 * ever ships). D256 deleted it with no relocation. The phrases it used are
 * never spelled anywhere under `app/status/` or the incident tree —
 * `status.test.ts` hunts them there, assembled from parts so the hunt does not
 * match itself (the D246 discipline). Some of those words do still appear
 * elsewhere under `src/`, in the M6 demo corpus that legitimately carries a
 * fictional customer (`src/mock/*`, `SideNav.tsx`): the fiction is not banned
 * from the product's demo, it is banned from obstack speaking about ITSELF.
 * What replaced it can only say true things, by construction:
 *
 *  - the components are NAMED AND DESCRIBED, not scored. There is no state
 *    pill, no dot and no percentage anywhere on this page, because obstack
 *    runs no monitor whose answer one could show. A green dot with nothing
 *    behind it is a claim, not a status;
 *  - the Monitoring section says exactly what is true today — that external
 *    uptime monitoring starts at launch and there are no numbers until then
 *    (D256's wording, kept verbatim);
 *  - the incident history is a directory of curated files
 *    (`src/content/status/incidents/`), each one written by a person. It ships
 *    EMPTY, so the section reads "No incidents recorded." — the honest launch
 *    state, not a placeholder.
 *
 * MODE-BLIND and prerendered: it asks no question about which data mode it is
 * in and imports nothing from the demo corpus, so both images serve the same
 * bytes. (Plenty of `/app` pages do import it — that is what a mock-mode demo
 * is. The narrower thing that is true, and pinned: `src/mock/rand.ts`, the
 * seeded PRNG the deleted uptime strip drew its ninety days from, has no
 * consumer outside `src/mock/` at all.) The route table prints it `○ (Static)`
 * rather than `● (SSG)`: `/status` has no dynamic segment and therefore no
 * `generateStaticParams`, which is the only thing `●` distinguishes. Both mean
 * prerendered at build time, and the notices are pulled in there, not per
 * request.
 *
 * `src/app/status/status.test.ts` reads this file as text and fails on a digit
 * followed by `%`, on the deleted page's vocabulary, and on either forbidden
 * edge.
 */

export const metadata: Metadata = {
  title: "Status — obstack",
  description: "obstack's components, its monitoring, and any incident notices it has published.",
};

/**
 * What each component IS — one true sentence apiece, and nothing else. No
 * state, because nothing measures one.
 *
 * The ids are NOT declared here: they come from `@/lib/docs/incidents`, which
 * is the same list an incident notice's `components` field is drawn from. A
 * `Record` keyed by that union means a new component cannot be added without
 * its sentence (typecheck), and rendering by mapping the id list means a
 * sentence cannot be added for a component the notices cannot reference. One
 * definition, checked in both directions by the compiler rather than by a
 * reviewer noticing.
 */
const componentIs: Record<StatusComponentId, string> = {
  app: "The web application — the demo today, and your workspace once it exists.",
  ingest:
    "The OTLP endpoint your self-hosted stack runs today — and the hosted one at launch.",
  docs: "This site's documentation.",
};

/** A notice's own state, coloured by what it means. Incidents are written; components are not. */
const statusColor: Record<IncidentStatus, string> = {
  investigating: "var(--color-err)",
  monitoring: "var(--color-warn)",
  resolved: "var(--color-ok)",
};

function SectionHeading({ children }: { children: string }) {
  return (
    <h2 className="mb-3 font-mono text-[11px] tracking-widest text-faint uppercase">{children}</h2>
  );
}

export default async function StatusPage() {
  const notices = await loadIncidents();
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3">
            <Link href="/" aria-label="obstack home">
              <Wordmark />
            </Link>
            <span className="font-mono text-[11px] text-faint">status</span>
          </div>
          {/*
            "Open the app", not "the demo". `/app` is a demo in one of the two
            images only: in the live image an anonymous reader is redirected to
            `/login` and a signed-in one lands in their own workspace. This page
            is the same bytes in both, so the label has to be true in both.
          */}
          <Link
            href="/app"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            Open the app <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12">
        <h1 className="font-display text-[28px] font-bold text-ink">Status</h1>
        <p className="mt-1 text-[14px] text-mid">
          The components an obstack deployment runs, and the incident notices it has published.
        </p>

        <section className="mt-10">
          <SectionHeading>components</SectionHeading>
          <div className="rounded-lg border border-line bg-surface">
            {STATUS_COMPONENT_IDS.map((id) => (
              <div key={id} className="border-b border-line/60 px-4 py-3.5 last:border-0">
                <p className="font-mono text-[12.5px] font-medium text-ink">{id}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-mid">{componentIs[id]}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <SectionHeading>monitoring</SectionHeading>
          <div className="rounded-lg border border-line bg-surface px-4 py-3.5">
            <p className="text-[13.5px] leading-relaxed text-mid">
              External uptime monitoring begins at launch; this page shows no uptime numbers until
              then.
            </p>
          </div>
        </section>

        <section className="mt-10">
          <SectionHeading>incidents</SectionHeading>
          {notices.length === 0 ? (
            <div className="rounded-lg border border-line bg-surface px-4 py-3.5">
              <p className="text-[13.5px] text-mid">No incidents recorded.</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {notices.map(({ file, frontmatter, Body }) => (
                <article key={file} className="rounded-lg border border-line bg-surface p-4">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <time className="font-mono text-[11px] text-faint">{frontmatter.date}</time>
                    <span
                      className="rounded-[3px] border px-1.5 py-px font-mono text-[9.5px] tracking-wide uppercase"
                      style={{ color: statusColor[frontmatter.status], borderColor: "var(--color-line)" }}
                    >
                      {frontmatter.status}
                    </span>
                    <span className="font-mono text-[10.5px] text-faint">
                      {frontmatter.components.join(" · ")}
                    </span>
                  </div>
                  <h3 className="mt-1.5 text-[16px] font-semibold text-ink">{frontmatter.title}</h3>
                  <div className="mt-1">
                    <Body />
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-8">
          <Wordmark />
          <p className="font-mono text-[11px] text-faint">© 2026 obstack</p>
        </div>
      </footer>
    </div>
  );
}
