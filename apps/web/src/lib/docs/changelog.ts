import { changelogManifest, type ChangelogManifestEntry } from "@/content/changelog/manifest";

/**
 * The changelog manifest, resolved (D320/D323) — the PURE half of the loader:
 * slug parsing and the newest-first order. No `fs`, no `next/*`, no MDX
 * import, so `changelog.test.ts` can import it directly under the suite's
 * `tsx --conditions react-server` runner, which has neither a filesystem
 * fixture nor an MDX loader.
 *
 * The half that actually pulls an entry in — the dynamic `import()` — is
 * `./changelog-load.ts`, because it only means anything inside a module Next
 * compiles. Same two-module split as `./docs.ts` + `./load.ts`, for the same
 * reason.
 */

export type { ChangelogManifestEntry };

/** The badge on an entry. A third value needs a colour in the page too. */
export type ChangelogKind = "new" | "improved";

/** The frontmatter contract every entry exports. See `src/content/changelog/README.md`. */
export interface ChangelogFrontmatter {
  /** `YYYY-MM-DD` — the master merge date of the PR that made the entry true (D323). */
  readonly date: string;
  readonly kind: ChangelogKind;
  readonly title: string;
}

/** `YYYY-MM-DD`, anchored: a slug's date prefix is a date or it is nothing. */
const SLUG_DATE = /^(\d{4}-\d{2}-\d{2})-.+$/;

/**
 * A file name's date prefix, or `null` if it has none.
 *
 * Two things read this. The test uses it to assert that a file's name and its
 * `frontmatter.date` agree, so the directory listing and the rendered page can
 * never tell different stories. `sortNewestFirst` does not use it at all — the
 * sort key is the frontmatter, because that is the value the page prints, and
 * a sort keyed on something other than what is displayed is a sort nobody can
 * check by looking.
 */
export function slugDate(slug: string): string | null {
  return SLUG_DATE.exec(slug)?.[1] ?? null;
}

/**
 * `"2026-08-20"` -> `"Aug 20, 2026"`, the format the page has always printed.
 *
 * Hand-rolled rather than `toLocaleDateString`, because a `YYYY-MM-DD` string
 * is a calendar date with no time and no zone in it: handing it to `Date` and
 * back would make the printed day depend on where the build ran, and a
 * changelog date that shifts by a timezone is a wrong date. It would also make
 * the output depend on the builder's default locale.
 *
 * A malformed date throws rather than rendering: an entry with no readable
 * date is a build-time shout, not a note that quietly appears undated. The
 * suite requires the format on every entry, so this is unreachable through a
 * green test run.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatEntryDate(date: string): string {
  const parts = ISO_DATE.exec(date);
  const month = parts ? MONTHS[Number(parts[2]) - 1] : undefined;
  if (!parts || !month) {
    throw new Error(`changelog: "${date}" is not a YYYY-MM-DD date`);
  }
  return `${month} ${Number(parts[3])}, ${parts[1]}`;
}

/** The shape `sortNewestFirst` orders: the slug it breaks ties with, and the frontmatter it sorts on. */
export interface DatedEntry {
  readonly slug: string;
  readonly frontmatter: { readonly date: string };
}

/** Lexicographic order, locale-free: dates and slugs are ASCII and must sort the same everywhere. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Newest first (D323) — the page's render order, computed rather than declared
 * (`manifest.ts` is deliberately kept in the opposite order so this comparator
 * is exercised by every build).
 *
 * The sort key is `frontmatter.date`, the value the page actually prints, and
 * not the same date sitting in the file name: an order keyed on something
 * other than what is displayed is an order nobody can check by looking. Dates
 * are `YYYY-MM-DD`, so a string comparison IS a chronological one — no `Date`
 * parsing, and therefore no timezone in the sort of a date that has no time in
 * it.
 *
 * TWO ENTRIES CAN SHARE A DATE — 2026-08-20 merged both the connections hub
 * (PR #19) and Explain (PR #20) — so the comparator needs a total order, or
 * the page's order silently depends on the manifest's, which the manifest
 * explicitly does not promise. The tie-break is the slug, descending: a
 * function of the files alone, stable across any manifest edit, and it happens
 * to put Explain above the connections hub, which is the order the two merged
 * in.
 */
export function sortNewestFirst<T extends DatedEntry>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) =>
    a.frontmatter.date === b.frontmatter.date
      ? compare(b.slug, a.slug)
      : compare(b.frontmatter.date, a.frontmatter.date),
  );
}

export { changelogManifest };
