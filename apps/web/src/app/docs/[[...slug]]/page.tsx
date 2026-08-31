import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";
import { DocsPage } from "@/components/docs/DocsPage";
import { docsStaticParams } from "@/lib/docs/docs";
import { docsMetadata } from "@/lib/docs/load";

/**
 * The PUBLIC docs mount — the site a stranger reads before signing up.
 *
 * The shape is the MDX guide's, verbatim
 * (node_modules/next/dist/docs/01-app/02-guides/mdx.md:275-325): a dynamic
 * segment, `generateStaticParams` listing the pages, `dynamicParams = false`
 * so anything else 404s, and the page itself pulled in by dynamic `import()`.
 * The one departure is that the list comes from `src/content/docs/manifest.ts`
 * instead of being spelled here (D320) — the same list the in-app mount and
 * `docs.test.ts` read.
 *
 * `[[...slug]]` rather than `[...slug]` because this mount owns `/docs` itself
 * as well as everything under it: an optional catch-all matches its base path
 * with no segments.
 *
 * Marketing chrome (the wordmark header, the CTA into the product) belongs to
 * this file and not to `DocsPage`: it is the half that must NOT appear inside
 * the app shell, where the reader already has a nav and is already in the
 * product.
 *
 * THE CTA SAYS "Open the app", not "Open the demo". `/app` is the demo only in
 * the mock image: in the live image an anonymous reader is redirected to
 * `/login` (`app/app/layout.tsx`) and a signed-in operator lands in their own
 * workspace. The label has to be true of both, because this page is one build
 * (D251/D267) and a mode branch here is exactly what `docs.test.ts` bans.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return docsStaticParams();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  // Shared with the in-app mount (`@/lib/docs/load`), not spelled twice: the
  // description reached one mount's `<head>` and not the other's for exactly
  // as long as this was a literal here.
  return docsMetadata(slug ?? []);
}

export default async function PublicDocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-3">
            <Link href="/" aria-label="obstack home">
              <Wordmark />
            </Link>
            {/*
              A LINK, not a label: this word is the only thing on a docs page
              that names the section, and on a phone — where the sidebar is
              `display: none` — it is the shortest route back to the index.
            */}
            <Link href="/docs" className="font-mono text-[11px] text-faint hover:text-mid">
              docs
            </Link>
          </div>
          <Link
            href="/app"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            Open the app <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <DocsPage slug={slug ?? []} basePath="/docs" />
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-8">
          <Wordmark />
          <p className="font-mono text-[11px] text-faint">© 2026 obstack</p>
        </div>
      </footer>
    </div>
  );
}
