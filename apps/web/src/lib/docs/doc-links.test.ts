import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { findDocsEntry, docsManifest } from "./docs";
import { PUBLIC_DOCS_BASE, isInternalHref, rebaseDocsHref } from "./doc-href";

// run with: npm test --workspace apps/web
//
// THE LINKS INSIDE THE PROSE (S4.4 R1 finding 6, D320's K2(b)).
//
// `src/content/docs/README.md` states the invariant the two mounts rest on:
// they differ by one prop, and "nothing else about a page may depend on where
// it is mounted". The nav honoured it; the BODY did not. The corpus is authored
// with absolute `/docs/...` hrefs, and an absolute href renders as itself — so
// every body link on `/app/docs/*` pointed at the public site, and a signed-in
// reader following one left the shell mid-sentence. Measured before the fix, in
// `.next/server/app/app/docs/quickstart.html`:
//
//   href="/docs/self-hosting/docker-compose"   ← inside the body
//   href="/docs/what-obstack-does-not-do"      ← inside the body
//   href="/app/docs/…" × 13                    ← the nav, correct all along
//
// The authoring convention did not change (an absolute href is what makes a
// link checkable against the manifest, below); the MOUNT rebases them, through
// the MDX `components` prop. Three things are pinned here:
//
//   1. the rule itself, as a pure function;
//   2. every `/docs/...` href in the corpus names a page the manifest carries;
//   3. the RENDERED result on both mounts — the only assertion that would have
//      caught the original bug, since every part of it was individually fine.

const HERE = path.dirname(import.meta.filename);
const WEB_SRC = path.resolve(HERE, "../..");
const APP_DIR = path.resolve(WEB_SRC, "..");
const DOCS = path.join(WEB_SRC, "content/docs");
const IN_APP_BASE = "/app/docs";

test("the rebasing rule: docs hrefs move, everything else is left alone", () => {
  // The public mount is the identity case, and it has to be: the corpus is
  // authored in its terms.
  assert.equal(rebaseDocsHref("/docs", PUBLIC_DOCS_BASE), "/docs");
  assert.equal(rebaseDocsHref("/docs/quickstart", PUBLIC_DOCS_BASE), "/docs/quickstart");
  // The in-app mount, including the fragment — five of the corpus's twenty
  // links carry one, and a rebasing that dropped it would land the reader on
  // the right page at the wrong place.
  assert.equal(rebaseDocsHref("/docs", IN_APP_BASE), "/app/docs");
  assert.equal(rebaseDocsHref("/docs/quickstart", IN_APP_BASE), "/app/docs/quickstart");
  assert.equal(rebaseDocsHref("/docs/sdks/typescript", IN_APP_BASE), "/app/docs/sdks/typescript");
  assert.equal(
    rebaseDocsHref("/docs/quickstart#send-your-first-trace", IN_APP_BASE),
    "/app/docs/quickstart#send-your-first-trace",
  );
  // THE SUFFIX ON THE BASE PATH ITSELF (S4.4 R3 finding 3). `/docs#…` and
  // `/docs?…` are `/docs` with something after it, and the matcher used to ask
  // two questions — is it exactly `/docs`, does it start with `/docs/` — of
  // which these are the answer to neither. They returned `null`, `DocLink`
  // rendered them unrebased, and a signed-in reader following one dropped out
  // of `/app/docs` onto the public marketing site: the one leak this module
  // exists to close, reached through the href shape it had no case for. Nothing
  // in the corpus writes one today, which is precisely why only a test can hold
  // the rule — the first author who links to the docs index by anchor would
  // otherwise reopen it silently.
  assert.equal(rebaseDocsHref("/docs#y", IN_APP_BASE), "/app/docs#y");
  assert.equal(rebaseDocsHref("/docs?x=1", IN_APP_BASE), "/app/docs?x=1");
  assert.equal(rebaseDocsHref("/docs?x=1#y", IN_APP_BASE), "/app/docs?x=1#y");
  // The public mount stays the identity case for those too.
  assert.equal(rebaseDocsHref("/docs#y", PUBLIC_DOCS_BASE), "/docs#y");
  assert.equal(rebaseDocsHref("/docs?x=1#y", PUBLIC_DOCS_BASE), "/docs?x=1#y");
  // `null` means "not mine — render it as the author wrote it".
  for (const href of [
    "#send-your-first-trace",
    "https://opentelemetry.io/docs/",
    "mailto:support@example.com",
    "/status",
    "/changelog",
    "/app/traces",
    "//evil.example.com/docs/x",
    "/docsomething",
    // The segment test survives the suffix handling: a longer FIRST SEGMENT is
    // still somebody else's route, whatever it carries after it.
    "/docsomething#y",
    "/docsomething?x=1",
    undefined,
  ]) {
    assert.equal(rebaseDocsHref(href, IN_APP_BASE), null, `${href} was rewritten and should not have been`);
  }
  // Internal is what decides `next/link` vs a plain anchor. A protocol-relative
  // URL starts with a slash and is NOT internal.
  assert.equal(isInternalHref("/status"), true);
  assert.equal(isInternalHref("//evil.example.com/x"), false);
  assert.equal(isInternalHref("https://example.com"), false);
  assert.equal(isInternalHref("#anchor"), false);
});

/** Every page in the corpus, with the absolute docs links its body carries. */
function corpusPages(): { slug: string[]; source: string; links: string[] }[] {
  const out: { slug: string[]; source: string; links: string[] }[] = [];
  const walk = (dir: string, slug: string[]) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, [...slug, entry.name]);
      else if (entry.name === "index.mdx") {
        const source = readFileSync(full, "utf8");
        // Markdown link targets only — `](…)`. A bare URL in a code fence is
        // not a link, and nothing in the corpus writes raw JSX anchors.
        const links = [...source.matchAll(/\]\((\/docs[^)\s]*)\)/g)].map((m) => m[1]);
        out.push({ slug, source, links });
      }
    }
  };
  walk(DOCS, []);
  return out;
}

const pages = corpusPages();

test("every /docs/... link in the corpus names a page the manifest carries", () => {
  // The authoring convention, checked: absolute hrefs are only safe to rebase
  // because they are also checkable. A link to a page that does not exist would
  // 404 identically on both mounts — this is the assertion that says so at test
  // time instead.
  const all = pages.flatMap((p) => p.links);
  assert.equal(all.length, 28, "the corpus's link count changed — update this deliberately"); // S8.1 T5: /docs/mcp links three pages; chart 0.7.0: the helm page links four (billing, quickstart, BYO OTel, mcp)
  for (const href of all) {
    const [pathname] = href.split("#");
    const segments = pathname.slice(PUBLIC_DOCS_BASE.length).split("/").filter(Boolean);
    assert.ok(findDocsEntry(segments), `${href} is not a page in src/content/docs/manifest.ts`);
  }
  // Not hollow: the resolver refuses something.
  assert.equal(findDocsEntry(["nope"]), null);
});

test("the body's `a` comes from the mount, and the mount is the only thing that knows", () => {
  // The mechanism, as source: `DocsPage` builds a link component from its
  // `basePath` and hands it to the compiled MDX body through the `components`
  // prop (`node_modules/next/dist/docs/01-app/02-guides/mdx.md:414-435` — it
  // merges with and overrides `src/mdx-components.tsx`). Deleting this line
  // would not fail a type check and would not fail a build; it would silently
  // restore the bug.
  const page = readFileSync(path.join(WEB_SRC, "components/docs/DocsPage.tsx"), "utf8");
  assert.ok(page.includes("const DocLink = docLinkFor(basePath);"), "DocsPage no longer builds a mount-aware link");
  assert.ok(page.includes("<Body components={{ a: DocLink }} />"), "the MDX body no longer receives the `a` override");
  // And no page of the corpus works around it by hard-coding the in-app prefix:
  // one authoring convention, or the rebasing is decoration.
  for (const p of pages) {
    assert.equal(
      p.source.includes(IN_APP_BASE),
      false,
      `/${p.slug.join("/")}: a page hard-codes the in-app mount — links are authored ${PUBLIC_DOCS_BASE}/… and rebased`,
    );
  }
});

/**
 * The prerendered HTML for a slug on a mount, or `null` when this tree has not
 * been built.
 *
 * Skipped locally, FAILED on CI (S4.4 R1 should-fix A). `npm test` does not
 * build, so a fresh checkout running the suite first would otherwise see a red
 * that says nothing about the code — but this arm is the only one that reads
 * what a reader actually receives, and "it skipped" is indistinguishable from
 * "it passed" in a green run. It skipped on every CI run of the sprint that
 * introduced it, because `web.yml` tested before it built. That order is now
 * the other way round and this is what holds it there.
 */
function prerendered(mount: "docs" | "app/docs", slug: string[]): string | null {
  const file = path.join(APP_DIR, ".next/server/app", mount + (slug.length ? `/${slug.join("/")}` : "") + ".html");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

test("the rendered body links stay on the mount the reader is on", (t) => {
  if (!prerendered("docs", ["quickstart"])) {
    const why =
      "no .next/server/app — this arm reads the PRERENDERED docs pages, so `npm run build` (apps/web) " +
      "must run before `npm test`; .github/workflows/web.yml orders it that way";
    assert.ok(!process.env.CI, why);
    t.skip(`${why} — skipped locally, fails on CI`);
    return;
  }
  assert.equal(docsManifest.length, 16); // S8.1 T5: +/docs/mcp
  let checkedBodyLinks = 0;
  for (const p of pages) {
    const at = `/${p.slug.join("/")}`;
    const inApp = prerendered("app/docs", p.slug);
    const publicHtml = prerendered("docs", p.slug);
    assert.ok(inApp, `${at}: no prerendered HTML on the in-app mount`);
    assert.ok(publicHtml, `${at}: no prerendered HTML on the public mount`);

    // THE assertion. Not "the body links were rewritten" but "nothing on this
    // page points at the public site" — the nav was always right, and the bug
    // was two links nobody was counting.
    const escaped = [...inApp.matchAll(/href="(\/docs[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(escaped, [], `${at} on /app/docs sends the reader to the public site`);

    for (const href of p.links) {
      const rebased = rebaseDocsHref(href, IN_APP_BASE);
      assert.ok(rebased, `${href} did not rebase`);
      // A link with no fragment is rendered twice — once by the nav, which
      // lists every page, and once by the body — so requiring two is what makes
      // this fail if the body link vanished rather than moved. A link TO a
      // section carries a fragment the nav never renders, so one is all there
      // is, and that one is the body's.
      const atLeast = href.includes("#") ? 1 : 2;
      assert.ok(
        inApp.split(`href="${rebased}"`).length - 1 >= atLeast,
        `${at}: the body link to ${href} is not rendered as ${rebased}`,
      );
      // The public mount renders it exactly as authored.
      assert.ok(
        publicHtml.includes(`href="${href}"`),
        `${at}: the body link to ${href} is not rendered as itself on /docs`,
      );
      checkedBodyLinks++;
    }
  }
  assert.equal(checkedBodyLinks, 24, /* S8.1 T5: /docs/mcp's three body links */ "the corpus's link count changed — update this deliberately");
});

// ───────────────────────────────────────────────── the fragment half (R1 B)

/**
 * A heading id the way `rehype-slug` writes one (S4.4 R1 should-fix B).
 *
 * The check above resolved a link's PAGE and stopped there, so
 * `/docs/quickstart#no-such-heading` was as green as a correct one — and five
 * of the corpus's twenty links carry a fragment, all of them pointing into a
 * page the reader has not scrolled yet. An anchor that misses lands them at the
 * top of a long page with no sign anything went wrong.
 *
 * The rule: lowercase, whitespace to `-`, drop everything outside
 * `[a-z0-9_-]`. Runs are NOT collapsed, and that is a measurement rather than a
 * preference — the arm below re-derives every id in the prerendered HTML from
 * the heading it was built from, and collapsing them failed on
 * `/docs/billing-and-plans`: "Over-quota ingestion degrades — it does not stop"
 * ships as `…degrades--it-does-not-stop`, because github-slugger (which
 * rehype-slug uses) DELETES the em dash and leaves the two hyphens the spaces
 * around it became. A rule that tidied that up would have declared the
 * corpus's own anchors broken.
 */
function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

/**
 * The ATX headings of an `.mdx` page. Fenced blocks are skipped: the helm
 * chart's install snippet is shell, and shell comments start with `#`.
 */
function headingsOf(source: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of source.split("\n")) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[2]);
  }
  return out;
}

/** The page a `/docs/...` href names, out of the corpus this file already walked. */
function corpusPageFor(pathname: string) {
  const segments = pathname.slice(PUBLIC_DOCS_BASE.length).split("/").filter(Boolean);
  return pages.find((p) => p.slug.join("/") === segments.join("/"));
}

/** Does this href name a page AND, if it carries one, a heading on that page? */
function anchorResolves(href: string): boolean {
  const [pathname, fragment] = href.split("#");
  const page = corpusPageFor(pathname);
  if (!page) return false;
  if (!fragment) return true;
  return headingsOf(page.source).map(slugifyHeading).includes(fragment);
}

test("every anchored /docs link points at a heading that is actually on that page", () => {
  const anchored = pages.flatMap((p) =>
    p.links.filter((href) => href.includes("#")).map((href) => ({ from: `/${p.slug.join("/")}`, href })),
  );
  assert.equal(anchored.length, 5, "the corpus's anchored-link count changed — update this deliberately");

  for (const { from, href } of anchored) {
    const [pathname] = href.split("#");
    const page = corpusPageFor(pathname);
    assert.ok(page, `${from} links to ${href} and no corpus page is mounted at ${pathname}`);
    assert.ok(
      anchorResolves(href),
      `${from} links to ${href}, and ${pathname} carries no such heading — it has ${headingsOf(page.source)
        .map(slugifyHeading)
        .join(", ")}`,
    );
  }

  // The falsification, on the exact shape R1 named: the page is real, the
  // heading is not, and this must be the difference between the two.
  assert.equal(anchorResolves("/docs/quickstart#send-your-first-trace"), true);
  assert.equal(anchorResolves("/docs/quickstart#no-such-heading"), false);
  assert.equal(anchorResolves("/docs/no-such-page#send-your-first-trace"), false);
});

test("the slug rule is the one the renderer actually applied", (t) => {
  // Not a second implementation trusted to agree with the first: every id in
  // the prerendered HTML is re-derived from the heading text in the `.mdx` it
  // was built from. If `rehype-slug` and the rule above ever disagree, the
  // corpus's own headings say so here.
  if (!prerendered("docs", ["quickstart"])) {
    const why =
      "no .next/server/app — this arm measures the slug rule against the PRERENDERED heading ids, " +
      "so `npm run build` (apps/web) must run before `npm test`";
    assert.ok(!process.env.CI, why);
    t.skip(`${why} — skipped locally, fails on CI`);
    return;
  }
  let checked = 0;
  for (const p of pages) {
    const html = prerendered("docs", p.slug);
    assert.ok(html, `/${p.slug.join("/")}: no prerendered HTML`);
    // `_R_` is React's own; every other id on a docs page is a heading's.
    const renderedIds = [...html.matchAll(/<h[1-6][^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      renderedIds,
      headingsOf(p.source).map(slugifyHeading),
      `/${p.slug.join("/")}: the ids the build wrote are not the ones this file's slug rule derives`,
    );
    checked += renderedIds.length;
  }
  assert.ok(checked > 40, `only ${checked} heading ids were compared — the extraction is missing some`);
});
