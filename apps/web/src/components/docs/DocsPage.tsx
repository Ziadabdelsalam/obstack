import { ChevronDown } from "lucide-react";
import { DocsNav } from "./DocsNav";
import { docLinkFor } from "./DocLink";
import { Prose } from "./Prose";
import { loadDoc, loadDocsNav } from "@/lib/docs/load";

/**
 * THE docs renderer (D320) — one component, two mounts.
 *
 * `src/app/docs/[[...slug]]/page.tsx` (public, SSG) and
 * `src/app/app/docs/[[...slug]]/page.tsx` (inside the app shell) are both
 * thin: they hand this the slug and a `basePath`, and that prop is the entire
 * difference between them. Two renderers would be two answers to "what do the
 * docs say", which is the divergence the whole manifest arrangement exists to
 * prevent.
 *
 * `basePath` reaches TWO things, and it has to reach both: the nav, and the
 * links inside the prose. The corpus authors absolute `/docs/...` hrefs, so
 * before `DocLink` existed a body link rendered as itself on `/app/docs/*` and
 * dropped a signed-in reader onto the marketing site mid-sentence — measured in
 * the prerendered HTML, twenty links across the corpus. The MDX `components`
 * prop is the seam (`mdx.md:414-435`: it merges with and overrides the global
 * map in `src/mdx-components.tsx`), so one line here fixes every page and no
 * page has to know which mount it is on.
 *
 * MODE-BLIND by construction: this file and everything it pulls in branch on
 * no data mode and import nothing from the demo corpus. The `live` and `mock`
 * web images are built from one source with only a build-time stamp between
 * them (D251/D267), so the docs a stranger reads on the marketing host and the
 * docs a signed-in operator reads in the shell are the same bytes. The two
 * forbidden edges are spelled once, in `src/lib/docs/docs.test.ts`, which
 * reads these files as text and fails on either — never spelled here, or this
 * docblock would be the thing that trips it (the `TourGuide.test.ts` D246
 * discipline: a sweep's needles do not appear in the files it sweeps).
 *
 * A server component: the MDX body is compiled React with no interactivity of
 * its own, so none of this reaches the browser as JavaScript. The mobile nav
 * keeps it that way — see below.
 */
export async function DocsPage({
  slug,
  basePath,
}: {
  slug: readonly string[];
  basePath: string;
}) {
  // `loadDoc` first: an off-manifest slug 404s before the nav is built.
  const { frontmatter, Body } = await loadDoc(slug);
  const sections = await loadDocsNav();
  const DocLink = docLinkFor(basePath);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-8 md:flex-row md:gap-10">
      <aside className="hidden w-52 shrink-0 md:block">
        <div className="sticky top-8">
          <DocsNav sections={sections} basePath={basePath} activeSlug={slug} />
        </div>
      </aside>
      {/*
        THE SAME NAV, for the width where the sidebar is `display: none`. Below
        `md` the aside above renders nothing at all, and until this existed a
        phone reader on any docs page had no route to any other docs page —
        not even back to the index — short of editing the URL.

        A `<details>`, not a drawer: it is the disclosure the platform already
        ships, so it opens, closes and takes focus with no JavaScript, no state
        and no `"use client"` — which is what lets this stay a server component
        and keeps the docs at zero client JS on both mounts. Collapsed, the
        summary still shows the title of the page being read — a nav that hides
        where you are is worse than no nav — so it doubles as the breadcrumb
        the sidebar would otherwise be providing.
      */}
      <details className="group rounded-md border border-line bg-surface md:hidden">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <span className="font-mono text-[10px] tracking-wide text-faint uppercase">docs</span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12.5px] text-ink">
            <span className="truncate">{frontmatter.title}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="border-t border-line px-3 py-3">
          <DocsNav sections={sections} basePath={basePath} activeSlug={slug} />
        </div>
      </details>
      <article className="min-w-0 flex-1">
        {frontmatter.description ? (
          <p className="mb-1 font-mono text-[11px] text-faint">{frontmatter.description}</p>
        ) : null}
        <Prose>
          <Body components={{ a: DocLink }} />
        </Prose>
      </article>
    </div>
  );
}
