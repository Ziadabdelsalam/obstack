import type { ComponentType } from "react";
import {
  changelogManifest,
  sortNewestFirst,
  type ChangelogFrontmatter,
  type ChangelogManifestEntry,
} from "./changelog";

/**
 * The half of the changelog loader that reaches an actual entry (D320/D323):
 * the dynamic `import()`. It runs inside a module Next compiles — the import
 * below is a Turbopack context module, not a runtime file read.
 *
 * NO `fs`, NO `path`, on any code path, for the same reason `./load.ts` has
 * none: the manifest is compiled in and the MDX modules are bundled beside it,
 * so there is nothing to walk even if some future mount of this content
 * rendered per request.
 */

export type { ChangelogFrontmatter };

export interface LoadedChangelogEntry {
  readonly slug: string;
  readonly frontmatter: ChangelogFrontmatter;
  readonly Body: ComponentType;
}

/**
 * The dynamic import, in the guide's shape
 * (`node_modules/next/dist/docs/01-app/02-guides/mdx.md:275-325`).
 *
 * ONE interpolation, of one variable, with `.mdx` written out. Measured on
 * 16.3.0 during T1: a NESTED template here compiles and then fails at
 * prerender with `Cannot find module`, because Turbopack builds the context
 * module from the template's literal parts. An entry's file name IS its slug —
 * no directory, no `index.mdx` — so the single-interpolation form falls out
 * for free; `changelog.test.ts` pins the line anyway, because the way it stops
 * being true is a refactor, not a decision.
 *
 * The result is typed by hand: TypeScript cannot resolve a computed import
 * specifier, so this is `any` at the boundary whatever we do. Better to state
 * the contract once here and have the corpus checked against it by the test
 * than to spread unchecked property access through the page.
 */
async function importEntry(entry: ChangelogManifestEntry): Promise<LoadedChangelogEntry> {
  const mod = (await import(`@/content/changelog/${entry.slug}.mdx`)) as {
    default: ComponentType;
    frontmatter?: Partial<ChangelogFrontmatter>;
  };
  const { frontmatter } = mod;
  if (
    !frontmatter ||
    typeof frontmatter.date !== "string" ||
    typeof frontmatter.title !== "string" ||
    (frontmatter.kind !== "new" && frontmatter.kind !== "improved")
  ) {
    // Unreachable through a green suite — `changelog.test.ts` requires all
    // three on every manifested entry — so this is the build-time shout for
    // the case where someone lands an entry without running the tests, rather
    // than a page rendering an undated note with an undefined badge.
    throw new Error(
      `changelog: src/content/changelog/${entry.slug}.mdx has no complete \`frontmatter\` export (date, kind, title)`,
    );
  }
  return { slug: entry.slug, frontmatter: frontmatter as ChangelogFrontmatter, Body: mod.default };
}

/**
 * Every release note, newest first (D323). The whole corpus, because
 * `/changelog` renders all of it: there is no per-entry route and nothing to
 * paginate.
 *
 * The sort is on `frontmatter.date` — the value the page prints — not on the
 * file name that carries the same date. The two are asserted equal by the
 * test; sorting on the displayed one means the order on the page can be
 * checked by reading the page.
 */
export async function loadChangelog(): Promise<LoadedChangelogEntry[]> {
  return sortNewestFirst(await Promise.all(changelogManifest.map(importEntry)));
}
