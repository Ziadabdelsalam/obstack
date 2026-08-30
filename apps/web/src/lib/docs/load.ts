import type { ComponentType } from "react";
import type { MDXComponents } from "mdx/types";
import { notFound } from "next/navigation";
import {
  contentPathFor,
  docsNavSections,
  findDocsEntry,
  type DocsManifestEntry,
} from "./docs";

/**
 * The half of the loader that reaches an actual page (D320): the dynamic
 * `import()` and the off-manifest `notFound()`. Everything here runs inside
 * modules Next compiles — the import below is a Turbopack context module, not
 * a runtime file read.
 *
 * NO `fs`, NO `path`, on any code path. The in-app mount renders per request
 * in the live image (`app/app/layout.tsx:110-112` awaits `connection()` and a
 * session), and the container's tree is a traced `.next/standalone` copy, so a
 * request-time directory read is both unmeasured and unnecessary: the manifest
 * is compiled in and the MDX modules are bundled beside it.
 */

/** The frontmatter contract every page exports. See `src/content/docs/README.md`. */
export interface DocsFrontmatter {
  readonly title: string;
  readonly description?: string;
}

/**
 * A compiled MDX body. The `components` prop is the MDX runtime's own
 * (`node_modules/next/dist/docs/01-app/02-guides/mdx.md:414-435`): what is
 * passed there merges with and overrides `src/mdx-components.tsx`'s map for
 * that render. `DocsPage` uses it for exactly one element — the `a`, so a body
 * link lands on the mount it was clicked from — and typing it here is what
 * makes that a checked call rather than a prop React would silently ignore.
 */
export type DocsBody = ComponentType<{ components?: MDXComponents }>;

export interface LoadedDoc {
  readonly entry: DocsManifestEntry;
  readonly frontmatter: DocsFrontmatter;
  readonly Body: DocsBody;
}

/**
 * The one dynamic import in the app, in the guide's shape
 * (`node_modules/next/dist/docs/01-app/02-guides/mdx.md:275-325` — "Using
 * dynamic imports", `await import(\`@/content/${slug}.mdx\`)` with
 * `generateStaticParams` + `dynamicParams = false`).
 *
 * Two constraints hold this line's exact form:
 *  - ONE interpolation, of one already-computed variable (`contentPathFor`
 *    explains why a nested template breaks the context module);
 *  - the `.mdx` extension is written out, as `:325` requires.
 *
 * The result is typed by hand. TypeScript cannot resolve a computed import
 * specifier, so this is `any` at the boundary whatever we do — better to state
 * the contract in one place and have the corpus checked against it by
 * `docs.test.ts` than to spread unchecked property access through the tree.
 */
async function importPage(entry: DocsManifestEntry): Promise<Omit<LoadedDoc, "entry">> {
  const contentPath = contentPathFor(entry.slug);
  const mod = (await import(`@/content/docs/${contentPath}.mdx`)) as {
    default: DocsBody;
    frontmatter?: DocsFrontmatter;
  };
  const frontmatter = mod.frontmatter;
  if (!frontmatter || typeof frontmatter.title !== "string") {
    // Unreachable through a green suite — `docs.test.ts` requires a string
    // `title` on every manifested page — so this is the build-time shout for
    // the case where someone lands a page and a manifest entry together
    // without running the tests, rather than a nav quietly rendering
    // `undefined` as a label.
    throw new Error(
      `docs: src/content/docs/${contentPath}.mdx has no string \`frontmatter.title\` export`,
    );
  }
  return { frontmatter, Body: mod.default };
}

/**
 * Slug → page, or a 404. THE off-manifest gate for BOTH mounts, in one place
 * (D320): the public mount also sets `dynamicParams = false`, but the in-app
 * mount lives under a layout that is dynamic in live mode, so the refusal
 * cannot be left to the prerender manifest.
 */
export async function loadDoc(slug: readonly string[]): Promise<LoadedDoc> {
  const entry = findDocsEntry(slug);
  if (!entry) notFound();
  return { entry, ...(await importPage(entry)) };
}

/** A nav entry: the manifest entry plus the title only its page knows. */
export interface DocsNavItem {
  readonly entry: DocsManifestEntry;
  readonly title: string;
}

export interface DocsNavSectionWithTitles {
  readonly section: string;
  readonly items: readonly DocsNavItem[];
}

/**
 * The nav, titled. Titles live in each page's `frontmatter` export and nowhere
 * else (D320), so building the nav means importing every page — cheap, because
 * they are all in the same bundle and a repeated `import()` of a loaded module
 * is a resolved promise, not a second compile.
 */
export async function loadDocsNav(): Promise<DocsNavSectionWithTitles[]> {
  return Promise.all(
    docsNavSections().map(async (section) => ({
      section: section.section,
      items: await Promise.all(
        section.entries.map(async (entry) => ({
          entry,
          title: (await importPage(entry)).frontmatter.title,
        })),
      ),
    })),
  );
}
