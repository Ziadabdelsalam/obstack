import { docsManifest, type DocsManifestEntry } from "@/content/docs/manifest";

/**
 * The manifest, resolved (D320) — the PURE half of the docs loader: slug
 * lookup, static params, nav grouping. No `fs`, no `next/*`, no MDX import, so
 * `docs.test.ts` can import it directly under the suite's
 * `tsx --conditions react-server` runner, which has neither a filesystem
 * fixture nor an MDX loader.
 *
 * The half that actually pulls a page in — the dynamic `import()` and the
 * `notFound()` — is `./load.ts`, because both only mean anything inside a
 * module Next compiles.
 */

export type { DocsManifestEntry };

/** A nav section: heading plus its pages, both in manifest order. */
export interface DocsNavSection {
  readonly section: string;
  readonly entries: readonly DocsManifestEntry[];
}

/** `/docs` + this = the page's URL. `[]` is the index. */
export function hrefFor(basePath: string, slug: readonly string[]): string {
  return slug.length === 0 ? basePath : `${basePath}/${slug.join("/")}`;
}

/**
 * The path under `src/content/docs/` that holds a slug's page, WITHOUT the
 * `.mdx` extension — `[]` → `"index"`, `["quickstart"]` → `"quickstart/index"`.
 *
 * This exists as a named function for one reason: it is the value `load.ts`
 * interpolates into its dynamic `import()`, and that import has to stay a
 * SINGLE interpolation of a single variable. Measured on 16.3.0: the nested
 * form ``import(`@/content/docs/${dir ? `${dir}/` : ""}index.mdx`)`` compiles
 * and then fails at prerender with `Cannot find module` — Turbopack's context
 * module is built from the literal parts of the template, and a nested
 * template leaves it nothing usable to glob. Keeping the whole variable part
 * in one expression, computed here, is what makes the import resolvable.
 */
export function contentPathFor(slug: readonly string[]): string {
  return [...slug, "index"].join("/");
}

/** Slug equality, order-sensitive. */
function sameSlug(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/**
 * THE gate. A slug that is not in the manifest is not a page, on either mount
 * — `null` here becomes `notFound()` in `load.ts`. This is deliberately not
 * left to `dynamicParams = false`: the in-app mount sits under a layout that
 * is dynamic in live mode (`app/app/layout.tsx:110-112`), and D320 rules that
 * off-manifest handling must not depend on the prerender path being taken.
 */
export function findDocsEntry(slug: readonly string[]): DocsManifestEntry | null {
  return docsManifest.find((entry) => sameSlug(entry.slug, slug)) ?? null;
}

/**
 * `generateStaticParams` for both mounts: the manifest, nothing else
 * (node_modules/next/dist/docs/01-app/02-guides/mdx.md:275-325 — the guide's
 * shape, with the list coming from the manifest instead of being spelled in
 * the route file).
 *
 * The index page's entry is `{ slug: undefined }`, and the key has to be
 * PRESENT. An optional catch-all matches its base path with no segments, so
 * `{ slug: [] }` is the wrong route — but MEASURED on 16.3.0, returning `{}`
 * (the key omitted rather than undefined) does not merely drop the index: the
 * build silently prerenders NOTHING for the route, quickstart included, and
 * still prints it as `●` in the route table with no children under it. There
 * is no warning and no error; the only symptom is a static page count that did
 * not go up. Hence the explicit `undefined` and the assertion on this exact
 * shape in `docs.test.ts`.
 */
export function docsStaticParams(): { slug?: string[] }[] {
  return docsManifest.map((entry) =>
    entry.slug.length === 0 ? { slug: undefined } : { slug: [...entry.slug] },
  );
}

/**
 * The manifest grouped for the nav: sections in first-appearance order, pages
 * inside a section in manifest order. Grouping is derived, never declared —
 * there is no second list of section names to fall out of step with this one.
 */
export function docsNavSections(): DocsNavSection[] {
  const sections: { section: string; entries: DocsManifestEntry[] }[] = [];
  for (const entry of docsManifest) {
    const existing = sections.find((s) => s.section === entry.section);
    if (existing) existing.entries.push(entry);
    else sections.push({ section: entry.section, entries: [entry] });
  }
  return sections;
}

export { docsManifest };
