import { DocsNav } from "./DocsNav";
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
 * its own, so none of this reaches the browser as JavaScript.
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
  return (
    <div className="mx-auto flex w-full max-w-6xl gap-10 px-5 py-8">
      <aside className="hidden w-52 shrink-0 md:block">
        <div className="sticky top-8">
          <DocsNav sections={sections} basePath={basePath} activeSlug={slug} />
        </div>
      </aside>
      <article className="min-w-0 flex-1">
        {frontmatter.description ? (
          <p className="mb-1 font-mono text-[11px] text-faint">{frontmatter.description}</p>
        ) : null}
        <Prose>
          <Body />
        </Prose>
      </article>
    </div>
  );
}
