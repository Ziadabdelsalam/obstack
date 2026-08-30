import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  contentPathFor,
  docsManifest,
  docsNavSections,
  docsStaticParams,
  findDocsEntry,
  hrefFor,
} from "./docs";

// run with: npm test --workspace apps/web
//
// The docs mechanism's gate (S4.4 T1, D319/D320). Three things are pinned
// here, and each of them is a thing that fails SILENTLY if it is not:
//
//   1. the manifest and the content tree agree, in BOTH directions (D206
//      mirror shape) — a page with no entry is unreachable and a entry with no
//      page is a build error nobody sees until the route is opened;
//   2. no module that SHIPS reads the filesystem (D320) — `/app/docs/*`
//      renders per request in the live image (`app/app/layout.tsx:110-112`),
//      where the tree is a traced `.next/standalone` copy;
//   3. the renderer is MODE-BLIND — the `live` and `mock` images are one build
//      with a build-time stamp between them (D251/D267), so both must serve
//      the same docs, and the way that stops being true is an import, not a
//      decision anybody writes down.
//
// `fs` IS used below, deliberately: this file runs at test time, on the source
// tree, and its whole job is to be the one place that looks at the real
// directory so that nothing at runtime has to.

const HERE = path.dirname(import.meta.filename);
const WEB_SRC = path.resolve(HERE, "../..");
const CONTENT_DOCS = path.join(WEB_SRC, "content/docs");
const read = (p: string) => readFileSync(path.join(WEB_SRC, p), "utf8");

/**
 * Every page in the tree, discovered the way a filesystem router would:
 * a page IS a directory containing `index.mdx`, and its slug is that
 * directory's path relative to `content/docs` (`src/content/docs/README.md`).
 */
function walkPages(dir: string, slug: string[] = []): { slug: string[]; file: string }[] {
  const found: { slug: string[]; file: string }[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === "index.mdx")) {
    found.push({ slug: [...slug], file: path.join(dir, "index.mdx") });
  }
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...walkPages(path.join(dir, entry.name), [...slug, entry.name]));
  }
  return found;
}

const pages = walkPages(CONTENT_DOCS);

test("D320: the manifest and the content tree are the same set, both ways", () => {
  const onDisk = pages.map((p) => p.slug.join("/")).sort();
  const manifested = docsManifest.map((e) => e.slug.join("/")).sort();
  // Both directions in one assertion: a page added without a manifest entry
  // would never appear in the nav or in `generateStaticParams` and would 404
  // through the loader's own gate; an entry with no page is a `Cannot find
  // module` at prerender. Neither is a thing to discover from a route.
  assert.deepEqual(
    onDisk,
    manifested,
    "src/content/docs/** and src/content/docs/manifest.ts disagree — every page needs exactly one entry",
  );
});

test("no .mdx file in the tree is unreachable", () => {
  // The slug is the DIRECTORY path, so `quickstart/notes.mdx` is a document
  // with no URL: it compiles, it is never served, and it reads like published
  // documentation to whoever wrote it.
  const stray: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mdx") && entry.name !== "index.mdx") {
        stray.push(path.relative(CONTENT_DOCS, full));
      }
    }
  };
  walk(CONTENT_DOCS);
  assert.deepEqual(stray, [], "a page must be `<slug>/index.mdx` — these files are unreachable");
});

test("D320: every page exports a string frontmatter.title", () => {
  // Read as text rather than imported: the suite runs under
  // `tsx --conditions react-server`, which has no MDX loader — the same reason
  // the shell tests read their components as source (D54(ii)). The contract
  // being checked is a literal in the file anyway (`content/docs/README.md`):
  // a computed title could not be a nav label at build time either.
  assert.ok(pages.length > 0, "the docs corpus is empty");
  for (const page of pages) {
    const source = readFileSync(page.file, "utf8");
    const at = `/${page.slug.join("/")}`;
    assert.match(
      source,
      /export const frontmatter = \{/,
      `${at}: no \`export const frontmatter\` (frontmatter is a named export here, not YAML — mdx.md:622-643)`,
    );
    const block = source.slice(source.indexOf("export const frontmatter = {"));
    assert.match(
      block.slice(0, block.indexOf("};") + 2),
      /title:\s*"[^"]+"/,
      `${at}: frontmatter.title is missing or is not a plain string literal`,
    );
  }
});

test("the loader resolves a manifested slug and refuses everything else", () => {
  assert.equal(findDocsEntry([])?.section, docsManifest[0].section, "the index page does not resolve");
  assert.ok(findDocsEntry(["quickstart"]), "/docs/quickstart does not resolve");
  // The 404 path, which is the half that matters: `null` here is the
  // `notFound()` in `load.ts`, applied on BOTH mounts (D320) rather than left
  // to `dynamicParams`, because the in-app mount sits under a layout that is
  // dynamic in live mode.
  assert.equal(findDocsEntry(["nope"]), null);
  assert.equal(findDocsEntry(["quickstart", "nope"]), null);
  assert.equal(findDocsEntry(["Quickstart"]), null, "slug matching must not be case-insensitive");
  // A prefix is not a page: a partial slug must not resolve to the page it is
  // a prefix of, in either direction.
  for (const entry of docsManifest) {
    if (entry.slug.length > 0) assert.equal(findDocsEntry([...entry.slug, "x"]), null);
  }
});

test("generateStaticParams is the manifest, with the index as the empty match", () => {
  const params = docsStaticParams();
  assert.equal(params.length, docsManifest.length);
  // `[[...slug]]` matches its own base path with NO segments, so the index
  // page's slug is `undefined` — `{ slug: [] }` would not be the same route.
  //
  // The key must be PRESENT and undefined, not absent. Measured on next
  // 16.3.0: returning `{}` for the index makes the build prerender NOTHING for
  // the whole route — every other entry in the array is dropped too — while
  // still printing it as `●` with no children. No warning, no error; the only
  // symptom is a static page count that did not move. This assertion is that
  // silence's alarm, so it checks the property key exists rather than just
  // deep-equalling a value that compares the same either way.
  assert.ok("slug" in params[0], "the index entry omits the `slug` key — that silently unbuilds every docs page");
  assert.equal(params[0].slug, undefined);
  assert.deepEqual(
    params.slice(1),
    docsManifest.slice(1).map((e) => ({ slug: [...e.slug] })),
  );
});

test("nav order IS array order, and sections group in first-appearance order", () => {
  const sections = docsNavSections();
  // Every entry appears exactly once, in the order the manifest lists it.
  assert.deepEqual(
    sections.flatMap((s) => s.entries.map((e) => e.slug.join("/"))),
    docsManifest.map((e) => e.slug.join("/")),
    "grouping reordered the manifest — nav order is the array's order, with no `order:` field to drift",
  );
  assert.deepEqual(
    sections.map((s) => s.section),
    [...new Set(docsManifest.map((e) => e.section))],
  );
});

test("one page, two mounts: only the basePath differs", () => {
  // The whole difference between `/docs` and `/app/docs` (D320's K2(b)).
  assert.equal(hrefFor("/docs", []), "/docs");
  assert.equal(hrefFor("/app/docs", []), "/app/docs");
  assert.equal(hrefFor("/docs", ["quickstart"]), "/docs/quickstart");
  assert.equal(hrefFor("/app/docs", ["sdks", "typescript"]), "/app/docs/sdks/typescript");
});

test("the content path is one interpolation, and it is the file that exists", () => {
  // Measured on next 16.3.0: a NESTED template in the dynamic import
  // (``@/content/docs/${dir ? `${dir}/` : ""}index.mdx``) compiles and then
  // fails at prerender with `Cannot find module`, because Turbopack builds the
  // context module from the template's literal parts. Keeping the variable
  // part in ONE expression is what makes it resolvable — so this function is
  // load-bearing, not a convenience.
  assert.equal(contentPathFor([]), "index");
  assert.equal(contentPathFor(["quickstart"]), "quickstart/index");
  const load = read("lib/docs/load.ts");
  assert.ok(
    load.includes("await import(`@/content/docs/${contentPath}.mdx`)"),
    "the dynamic import is no longer a single interpolation of a precomputed path",
  );
  for (const page of pages) {
    assert.equal(
      readFileSync(path.join(CONTENT_DOCS, `${contentPathFor(page.slug)}.mdx`), "utf8").length > 0,
      true,
    );
  }
});

// The modules that make up the docs mechanism, as text. Everything the two
// route files reach that is not framework code.
const RENDERER_SOURCES: Record<string, string> = {
  "lib/docs/docs.ts": read("lib/docs/docs.ts"),
  "lib/docs/load.ts": read("lib/docs/load.ts"),
  "content/docs/manifest.ts": read("content/docs/manifest.ts"),
  "components/docs/DocsPage.tsx": read("components/docs/DocsPage.tsx"),
  "components/docs/DocsNav.tsx": read("components/docs/DocsNav.tsx"),
  "components/docs/Prose.tsx": read("components/docs/Prose.tsx"),
  "mdx-components.tsx": read("mdx-components.tsx"),
  "app/docs/[[...slug]]/page.tsx": read("app/docs/[[...slug]]/page.tsx"),
  "app/app/docs/[[...slug]]/page.tsx": read("app/app/docs/[[...slug]]/page.tsx"),
};

// NX4/D251: `images.yml` builds `obstack-web:live` and `obstack-web:mock` from
// ONE source with a build-time stamp between them, so the docs must compile to
// the same bytes in both. The way that stops being true is not a decision
// anyone records — it is an import that arrives in a refactor, exactly as it
// did in S1 L2 (D125/D158). Same test shape as
// `components/onboarding/Quickstart.test.ts:217-222`: read the source, ban the
// edge.
test("the docs renderer is mode-blind — no @/mock/* edge, no mode branch", () => {
  for (const [name, source] of Object.entries(RENDERER_SOURCES)) {
    assert.equal(/from "@\/mock\//.test(source), false, `${name} imports a mock module`);
    assert.equal(source.includes("@/mock/"), false, `${name} names a mock module at all`);
    assert.equal(source.includes("resolveMode"), false, `${name} branches on the data mode`);
    assert.equal(source.includes("dataMode"), false, `${name} reads the data mode`);
  }
});

test("D320: no module that ships reads the filesystem", () => {
  // `/app/docs/*` renders per request in the live image, and the container's
  // tree is a traced `.next/standalone` copy — NX3 measured the build-time
  // walk, never a request-time one. The manifest exists so there is nothing to
  // walk; this is the assertion that keeps it that way.
  for (const [name, source] of Object.entries(RENDERER_SOURCES)) {
    for (const banned of ['from "fs"', "from 'fs'", "node:fs", "node:path", 'from "path"', "readdirSync", "readFileSync"]) {
      assert.equal(source.includes(banned), false, `${name} reaches the filesystem (${banned})`);
    }
  }
});

test("NX3: every MDX component override spreads ...props", () => {
  // Measured: `rehype-slug` puts the heading `id` on the element as a prop, so
  // an override that writes its own attributes without spreading drops it
  // silently — the page renders, and every in-page anchor in the corpus is
  // dead. The failure has no symptom at build time, which is why it is pinned
  // here rather than trusted to review.
  const source = RENDERER_SOURCES["mdx-components.tsx"];
  const parts = source.split("(props) =>");
  assert.ok(parts.length > 1, "mdx-components.tsx has no component overrides at all");
  for (let i = 1; i < parts.length; i++) {
    // Everything up to the next override is this one's body.
    assert.ok(
      parts[i].includes("{...props}"),
      `an override in mdx-components.tsx does not spread props: ...${parts[i].slice(0, 60).trim()}`,
    );
  }
  // mdx-components.md:36 — the exported function takes NO arguments in this
  // version. The pre-16 signature received the inherited components and merged
  // them, and that form is the one in most training data.
  assert.match(source, /export function useMDXComponents\(\): MDXComponents \{/);
});
