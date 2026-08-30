import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Wordmark } from "@/components/shell/Wordmark";
import { DocsPage } from "@/components/docs/DocsPage";
import { docsStaticParams } from "@/lib/docs/docs";
import { loadDoc } from "@/lib/docs/load";

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
 * Marketing chrome (the wordmark header, the demo CTA) belongs to this file
 * and not to `DocsPage`: it is the half that must NOT appear inside the app
 * shell, where the reader already has a nav and is already in the product.
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
  const { frontmatter } = await loadDoc(slug ?? []);
  return {
    title: `${frontmatter.title} — obstack docs`,
    ...(frontmatter.description ? { description: frontmatter.description } : {}),
  };
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
            <span className="font-mono text-[11px] text-faint">docs</span>
          </div>
          <Link
            href="/app"
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium text-bg"
            style={{ background: "var(--color-ink)" }}
          >
            Open the demo <ArrowRight className="h-3.5 w-3.5" />
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
