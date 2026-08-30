import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";
import { formatEntryDate, type ChangelogKind } from "@/lib/docs/changelog";
import { loadChangelog } from "@/lib/docs/changelog-load";

/**
 * The public changelog — one release note per file under
 * `src/content/changelog/**`, on the same MDX pipeline as the docs (D255/D323).
 *
 * This page used to BE the changelog: a hardcoded array of four entries plus a
 * docblock explaining what they were allowed to say. Both moved into the
 * content tree — the entries to dated `.mdx` files, the editorial posture to
 * `src/content/changelog/README.md` — so a release note is now content that
 * the repo-wide D246 sweep walks and that `src/lib/docs/changelog.test.ts`
 * pins, instead of source that only a reviewer would ever read.
 *
 * Mode-blind, like the docs renderer: this route imports no mock module and
 * asks nothing about the data mode. The `live` and `mock` images are one build
 * (D251/D267) and must serve the same words. Pinned by `changelog.test.ts`,
 * which reads this file as text — which is also why neither the banned import
 * path nor the mode helper's name is spelled out anywhere above (D246
 * discipline: a file that names the thing it bans becomes a hit).
 */

/**
 * The badge, per `frontmatter.kind`. Exhaustive over the union by type, so
 * widening `ChangelogKind` without picking a colour does not compile — the
 * failure mode this replaces was a `Record<string, …>` lookup that returned
 * `undefined` and crashed the page on an unknown kind.
 */
const KIND_COLOR: Record<ChangelogKind, string> = {
  new: "var(--color-api)",
  improved: "var(--color-agent)",
};

export default async function ChangelogPage() {
  const entries = await loadChangelog();

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
          {entries.map(({ slug, frontmatter, Body }) => (
            <article key={slug} className="relative pb-8 pl-7 last:pb-0">
              <span
                className="absolute top-1.5 -left-[5px] h-[9px] w-[9px] rounded-full border-2 border-bg"
                style={{ background: KIND_COLOR[frontmatter.kind] }}
              />
              <div className="flex flex-wrap items-center gap-2.5">
                <time dateTime={frontmatter.date} className="font-mono text-[11px] text-faint">
                  {formatEntryDate(frontmatter.date)}
                </time>
                <span
                  className="rounded-[3px] px-1.5 py-px font-mono text-[9.5px] tracking-wide uppercase"
                  style={{
                    color: KIND_COLOR[frontmatter.kind],
                    background: `color-mix(in srgb, ${KIND_COLOR[frontmatter.kind]} 12%, transparent)`,
                  }}
                >
                  {frontmatter.kind}
                </span>
              </div>
              <h2 className="mt-1.5 text-[16px] font-semibold text-ink">{frontmatter.title}</h2>
              {/*
                The note's body, rendered through `src/mdx-components.tsx` like
                every other MDX body in the app. Its `p` override carries the
                docs' paragraph rhythm (`mt-3.5`); an entry's first paragraph
                sits directly under its own title, so it takes the tighter gap
                the array-driven page used — the same shape `Prose` uses to
                open a docs page.
              */}
              <div className="[&>p:first-child]:mt-1">
                <Body />
              </div>
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
