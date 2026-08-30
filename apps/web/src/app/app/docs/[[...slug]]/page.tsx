import type { Metadata } from "next";
import { DocsPage } from "@/components/docs/DocsPage";
import { docsStaticParams } from "@/lib/docs/docs";
import { loadDoc } from "@/lib/docs/load";

/**
 * The IN-APP docs mount (D320's K2(b)) — the same pages, inside the shell.
 *
 * It renders the same `DocsPage` over the same manifest as `/docs`; the only
 * difference is `basePath`, so every link in the nav keeps a reader who is
 * already signed in inside the app instead of dropping them onto the public
 * site. The shell around it — nav, top bar, palette — comes from
 * `app/app/layout.tsx`, and the auth wall in live mode is that layout's
 * (`:131`), not a decision this route makes.
 *
 * `generateStaticParams` is here so mock mode prerenders these pages exactly
 * as it prerenders the rest of `/app`. `dynamicParams` is deliberately NOT set
 * to `false` as a gate: in live mode the parent layout awaits `connection()`
 * and a session (`:110-112`), so this route renders per request and the
 * prerender manifest is not what answers "is this a page". The refusal lives
 * in the loader instead — `loadDoc` calls `notFound()` on any slug the
 * manifest does not carry, on both mounts, in one place (D320).
 *
 * D321: `/app/docs` is PRODUCT CHROME, not a data surface. It reads no
 * workspace data in either mode, so it carries neither the live-mode
 * "SAMPLE DATA — preview" badge nor the mock-mode demo footer — the docs are
 * true in both images, and saying "every screen here is sample data" under a
 * real self-hosting instruction would be the inverse lie. See
 * `src/lib/live-routes.ts`.
 */

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
  return { title: `${frontmatter.title} — obstack docs` };
}

export default async function InAppDocsPage({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  return <DocsPage slug={slug ?? []} basePath="/app/docs" />;
}
