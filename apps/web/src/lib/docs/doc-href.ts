/**
 * One page, two mounts — the half the NAV could not solve (D320's K2(b)).
 *
 * `DocsNav` builds its own hrefs from `basePath`, so the sidebar always kept a
 * reader on the mount they were already on. A LINK INSIDE THE PROSE could not:
 * the corpus is authored with absolute `/docs/...` hrefs (one authoring
 * convention, checked against the manifest by `doc-links.test.ts`), and an
 * absolute href renders as itself. Measured on the prerendered output before
 * this existed: `.next/server/app/app/docs/quickstart.html` carried
 * `href="/docs/self-hosting/docker-compose"` and
 * `href="/docs/what-obstack-does-not-do"` — two body links that dropped a
 * signed-in reader out of the shell and onto the marketing site, from a page
 * whose nav was entirely `/app/docs/…`. Twenty such links exist across the
 * corpus.
 *
 * So the mount rebases them at render (`@/components/docs/DocLink`, passed to
 * the MDX body as its `a` component), and this is the pure rule it applies.
 * That keeps `src/content/docs/README.md`'s invariant true as written —
 * "nothing else about a page may depend on where it is mounted" — rather than
 * true of everything except its links.
 */

/** The public mount's base path, and therefore the prefix the corpus authors. */
export const PUBLIC_DOCS_BASE = "/docs";

/**
 * A body link's href, rebased onto `basePath` — or `null` when it is not a
 * docs href and must be left exactly as the author wrote it.
 *
 * `/docs` → `${basePath}`, `/docs/x#y` → `${basePath}/x#y`. Everything else is
 * `null`: an external URL, a bare `#anchor`, a `mailto:`, and a link to any
 * other part of the site (`/status`, `/changelog`) — those mean the same page
 * from either mount, so rewriting them would send a reader somewhere that does
 * not exist. `/docsomething` is not a docs href either: the prefix is a path
 * segment, not a string prefix.
 */
export function rebaseDocsHref(href: string | undefined, basePath: string): string | null {
  if (typeof href !== "string") return null;
  if (href === PUBLIC_DOCS_BASE) return basePath;
  if (href.startsWith(`${PUBLIC_DOCS_BASE}/`)) {
    return `${basePath}${href.slice(PUBLIC_DOCS_BASE.length)}`;
  }
  return null;
}

/**
 * Whether an href points inside this site — the test for "render it with
 * `next/link`". Protocol-relative `//host/x` is NOT internal, which is the one
 * case a naive `startsWith("/")` gets wrong.
 */
export function isInternalHref(href: string | undefined): href is string {
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//");
}
