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
  assert.equal(all.length, 20, "the corpus's link count changed — update this deliberately");
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
 * SKIPPED, NOT FAILED, when `.next` is absent: `npm test` does not build, and a
 * fresh checkout running the suite first would otherwise see a red that says
 * nothing about the code. The check is worth having anyway — it is the only one
 * that reads what a reader actually receives — and CI builds before it tests.
 */
function prerendered(mount: "docs" | "app/docs", slug: string[]): string | null {
  const file = path.join(APP_DIR, ".next/server/app", mount + (slug.length ? `/${slug.join("/")}` : "") + ".html");
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

test("the rendered body links stay on the mount the reader is on", (t) => {
  if (!prerendered("docs", ["quickstart"])) {
    t.skip("no .next/server/app — run `npm run build` in apps/web for this one (it reads the prerendered HTML)");
    return;
  }
  assert.equal(docsManifest.length, 14);
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
  assert.equal(checkedBodyLinks, 20, "the corpus's link count changed — update this deliberately");
});
