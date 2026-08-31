/**
 * THE changelog manifest (D320, applied to the changelog by D323) — the source
 * of truth for which release notes exist.
 *
 * Same rule as `src/content/docs/manifest.ts`, for the same reason: no module
 * that ships reads the filesystem. `/changelog` is a static route today, but
 * "static today" is not a property anything enforces, and the docs mechanism
 * this borrows from mounts inside a layout that is dynamic in live mode. One
 * shape for both means there is no second convention to get wrong later.
 * `src/lib/docs/changelog.test.ts` walks `src/content/changelog/*.mdx` with
 * `fs` at TEST time and fails if this list and the directory ever disagree in
 * either direction (D206 mirror shape).
 *
 * ORDER HERE IS NOT RENDER ORDER, and that is deliberate. The page renders
 * newest-first by sorting on each entry's `frontmatter.date` (D323), so this
 * list is kept OLDEST-first: if it were written in render order, a broken
 * comparator would still produce the right page and no test could tell the
 * difference. Listing it the other way round means the sort is exercised
 * every time the page is built.
 *
 * ADDING AN ENTRY (the whole procedure):
 *   1. create `src/content/changelog/YYYY-MM-DD-slug.mdx`, where the date is
 *      the master merge date of the PR that made the entry TRUE — see
 *      `README.md` beside this file, which is where the date rule lives;
 *   2. add its slug here.
 * Doing either half alone turns `changelog.test.ts` red, which is the point.
 */

/** A release note's address: the file's name under `src/content/changelog/`, without `.mdx`. */
export interface ChangelogManifestEntry {
  /** `YYYY-MM-DD-slug` — the date prefix must equal the file's `frontmatter.date`. */
  readonly slug: string;
}

export const changelogManifest: readonly ChangelogManifestEntry[] = [
  { slug: "2026-08-16-traces-carry-their-logs" },
  { slug: "2026-08-17-logs-explorer" },
  { slug: "2026-08-20-connections-hub" },
  { slug: "2026-08-20-explain-this-trace" },
];
