import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { STATUS_COMPONENT_IDS } from "@/lib/docs/incidents";

// run with: npm test --workspace apps/web
//
// `/status` is obstack's own status page now (S4.4 T4, D256/D324). What stood
// here before was a demo of a fictional customer's page: ninety days of
// seeded-PRNG availability blocks, four components carrying invented figures,
// an invented resolved incident, and a header crediting it all to an obstack
// capability that does not exist. D256 deleted it with no relocation.
//
// This file is mostly a TEXT test for the same reason the shell tests are
// (D54(ii)): the page is a server component and the runner is pinned to
// `--conditions react-server`, so the source is what most of the assertions
// below read — the right grain for them, because every banned thing here is
// a literal somebody would type.
//
// The D342 monitoring tests are the one exception: what they check is
// env-dependent BEHAVIOUR (which of two arms the page renders), and that is
// not a fact the source text carries either way — the conditional is in the
// source regardless of which arm runs. So those two RENDER the real page
// module instead, walking the element tree the server returns, the same
// shim `signup/mock-mode.test.ts` uses for the same obstacle: under
// `--conditions react-server` React has no `createContext`, and `next/link`
// calls it at module scope, so importing a real page module needs this one
// function supplied first. Nothing below ever CALLS `<Link>` or
// `<Wordmark>` — a React element is a plain object, and the tree is only
// walked, never rendered.
const react = createRequire(import.meta.url)("react");
react.createContext ??= () => ({});
//
// THE NEEDLES ARE ASSEMBLED FROM PARTS, never spelled (the D246 discipline
// TourGuide.test.ts established). `apps/web/src` is swept for these phrases in
// the sprint's exit check; a test that spelled them would be the hit it is
// looking for, and the sweep's silence would then be a lie.

const HERE = path.dirname(import.meta.filename);
const WEB_SRC = path.resolve(HERE, "../..");
const read = (p: string) => readFileSync(path.join(WEB_SRC, p), "utf8");

/** Does this text carry that phrase, in ANY casing? The one fold this file uses. */
const says = (source: string, phrase: string) => source.toLowerCase().includes(phrase.toLowerCase());

/**
 * The MODULES `/status` reaches that are not framework code. The incident
 * loader is in here too — a percentage or a fabricated state does not become
 * acceptable by being one import away.
 */
const MODULES: Record<string, string> = {
  "app/status/page.tsx": read("app/status/page.tsx"),
  "lib/docs/incidents.ts": read("lib/docs/incidents.ts"),
  "lib/docs/incidents-load.ts": read("lib/docs/incidents-load.ts"),
  "content/status/incidents/manifest.ts": read("content/status/incidents/manifest.ts"),
};

const INCIDENTS_DIR = path.join(WEB_SRC, "content/status/incidents");

/**
 * Every PUBLISHED NOTICE, as text — a notice is a top-level `.mdx` file in
 * that directory (`content/status/incidents/README.md`).
 *
 * Read at test time rather than listed, because the set is meant to grow: the
 * bans below are on what `/status` SAYS, and after the manifest gains its first
 * entry most of what the page says will be a notice's prose. A notice reaching
 * the page without passing the needles would make the README's promise
 * ("`status.test.ts` fails on a digit followed by `%`", `README.md:86-88`) a
 * sentence about the four modules only — true of the mechanism, false of the
 * page a stranger reads. The directory ships empty, so this contributes nothing
 * today and everything the day it stops being empty.
 */
function noticeSources(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(INCIDENTS_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".mdx"))
      .map((e) => [
        `content/status/incidents/${e.name}`,
        readFileSync(path.join(INCIDENTS_DIR, e.name), "utf8"),
      ]),
  );
}

/** THE `/status` surface: the modules, plus every notice they publish. */
const SURFACE: Record<string, string> = { ...MODULES, ...noticeSources() };
const pageSource = MODULES["app/status/page.tsx"];

// The tree-walking helpers below are `signup/mock-mode.test.ts`'s, copied
// rather than imported (that file's are not exported, and reimplementing
// four one-line functions is cheaper than opening a cross-directory export
// surface for a test helper). A React element is a plain object; nothing
// here ever calls `<Link>` or `<Wordmark>`, only walks the tree the server
// component returns.
type Element = { type?: unknown; props?: Record<string, unknown> };

/** Every element and string in a returned tree, depth-first. */
function flatten(node: unknown, out: (Element | string)[] = []): (Element | string)[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) for (const child of node) flatten(child, out);
  else if (node && typeof node === "object") {
    const el = node as Element;
    out.push(el);
    flatten(el.props?.children, out);
  }
  return out;
}

const renderedText = (tree: unknown) => flatten(tree).filter((n) => typeof n === "string").join(" ");

const anchorHrefs = (tree: unknown) =>
  flatten(tree)
    .filter((n): n is Element => typeof n === "object" && n.type === "a")
    .map((n) => n.props?.href)
    .filter((h): h is string => typeof h === "string");

/** The page's text with JSX line-wrapping flattened, so a sentence can be matched as a sentence. */
const pageText = pageSource.replace(/\s+/g, " ");

test("D256: no number on this page claims availability", () => {
  // The single assertion the ruling names. A digit followed by `%` is the
  // shape of every uptime figure the deleted page carried, and there is no
  // honest one to write until an external monitor exists — so the rule is not
  // "no wrong numbers", it is "no numbers".
  for (const [name, source] of Object.entries(SURFACE)) {
    const hit = /\d%/.exec(source);
    assert.equal(hit, null, `${name} carries a percentage (${hit?.[0]}) — there is nothing measuring one`);
  }
});

test("D256: the deleted page's vocabulary does not come back", () => {
  // Assembled, never spelled — see the header. Each pair is a phrase from the
  // fiction: the fictional customer's page title and host, the credit to a
  // capability obstack does not have, the invented incident's id, the seeded
  // strip and its component, and the generator that fed it.
  const banned = [
    ["Loopwork", "status"].join(" "),
    ["status", "loopwork"].join("."),
    ["powered by obstack", "SLOs"].join(" "),
    ["INC", "42"].join("-"),
    ["All systems", "operational"].join(" "),
    ["uptime", "90d"].join(""),
    ["Uptime", "Strip"].join(""),
    ["mulberry", "32"].join(""),
    // A component cannot be labelled with a state at all: nothing measures
    // one, so the word is banned outright rather than only in its old phrase.
    ["operat", "ional"].join(""),
  ];
  // FOLDED, on both sides (S4.4 R3 finding 2). This read `source.includes(phrase)`
  // until R3, and half these needles are assembled Title-Cased — so the check
  // was simultaneously too strict (a lower-case revival of "Loopwork status"
  // walked past it) and too loose (a Title-Cased one of the lower-case needles
  // did too). UI copy arrives Title-Cased; a case-sensitive ban on a phrase
  // somebody would type as a heading is a ban on one spelling of it. The
  // landing fence's registry folds for the same reason, in one place.
  for (const [name, source] of Object.entries(SURFACE)) {
    for (const phrase of banned) {
      assert.equal(says(source, phrase), false, `${name} says "${phrase}" again`);
    }
  }
});

test("the page is mode-blind and reads no filesystem", () => {
  // `/status` is public and prerendered, and the `live` and `mock` images are
  // one build with a stamp between them (D251/D267): the page a stranger opens
  // must not depend on which image served it. This is what keeps that edge from
  // being re-added by a refactor (D125/D158, S1 L2).
  //
  // MODULES, not SURFACE: these are bans on CODE — an import, a mode branch, an
  // `fs` call. A notice is prose written after an outage, and one describing a
  // filesystem bug would have to name `readFileSync` to be worth reading. What
  // a notice may not SAY is the two tests above, and those read the notices.
  for (const [name, source] of Object.entries(MODULES)) {
    assert.equal(/from "@\/mock\//.test(source), false, `${name} imports a mock module`);
    assert.equal(source.includes("@/mock/"), false, `${name} names a mock module at all`);
    assert.equal(source.includes("resolveMode"), false, `${name} branches on the data mode`);
    assert.equal(source.includes("dataMode"), false, `${name} reads the data mode`);
    // D320: nothing that ships walks a directory. The manifest is the index.
    for (const banned of ['from "fs"', "from 'fs'", "node:fs", "node:path", 'from "path"', "readdirSync", "readFileSync"]) {
      assert.equal(source.includes(banned), false, `${name} reaches the filesystem (${banned})`);
    }
  }
});

/** Every file under `dir`, recursively — the tree, grepped at test time. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(full) : [full];
  });
}

test("the seeded generator behind the deleted strip has no consumer outside src/mock/", () => {
  // The page's docblock says this, so it is checked rather than believed — and
  // the claim is narrow ON PURPOSE. It is NOT "the demo corpus has one
  // consumer": 21 files under `src/app` import `@/mock/*`, because a mock-mode
  // demo is what those pages ARE. It is that `src/mock/rand.ts` — mulberry32
  // and its helpers, the seeded PRNG the deleted uptime strip drew ninety days
  // of availability from — is reached only from inside `src/mock/`, by the
  // generators. No page renders from it, so no page can grow a fabricated
  // series without that import landing in a diff first.
  //
  // What is hunted is an IMPORT, not a mention: this file and the page both
  // name the module in prose, and a docblock explaining the rule must not be
  // the thing that breaks it (the D246 discipline again).
  const spec = ["mock", "rand"].join("/"); // assembled: this file is swept too
  const importsIt = new RegExp(`(?:from|import\\()\\s*"[^"]*${spec}"`);
  const mockDir = path.join(WEB_SRC, "mock");
  const offenders = filesUnder(WEB_SRC)
    .filter((f) => !f.startsWith(mockDir + path.sep))
    .filter((f) => importsIt.test(readFileSync(f, "utf8")))
    .map((f) => path.relative(WEB_SRC, f));
  assert.deepEqual(offenders, [], "the seeded generator is imported outside src/mock/");

  // Not hollow, in both directions. The needle catches a real import of it —
  // the fixture is assembled from `spec` for the same reason the needle is: a
  // literal one here would be a consumer of the module in the sweep's eyes,
  // and this test would fail on itself.
  assert.ok(importsIt.test(`import { between } from "@/${spec}";`), "the needle matches nothing");
  // …and the module it names is still there, still imported by the generators
  // that live beside it (relatively, which is why the sweep above cannot see
  // them and does not need to).
  assert.ok(existsSync(path.join(mockDir, "rand.ts")), "src/mock/rand.ts is gone");
  assert.ok(
    filesUnder(mockDir).some((f) => /from "\.\/rand"/.test(readFileSync(f, "utf8"))),
    "nothing in src/mock imports the seeded generator either — it is dead, and this test is about nothing",
  );
});

test("every component is named and described, and none is scored", () => {
  // D324's shape: a name plus one true sentence about what the thing IS.
  // The ids are not re-declared here — they come from the module a notice's
  // `components` field is checked against, so this fails if the page and the
  // notices ever stop talking about the same three things.
  assert.deepEqual([...STATUS_COMPONENT_IDS], ["app", "ingest", "docs"]);
  for (const id of STATUS_COMPONENT_IDS) {
    assert.ok(
      new RegExp(`\\b${id}:\\s*"`).test(pageSource),
      `the page has no sentence for the "${id}" component`,
    );
  }
  assert.ok(pageText.includes("The web application — the demo today, and your workspace once it exists."));
  // The `ingest` sentence is hedged, and the hedge is the assertion: obstack
  // publishes no OTLP endpoint today, so "the endpoint your telemetry is sent
  // to" would name a hosted service that does not exist yet — the same claim
  // `/docs/connectors/overview` refuses to make ("the hosted endpoint a drain
  // or a subscription filter would be pointed at is not public yet").
  assert.ok(
    pageText.includes(
      "The OTLP endpoint your self-hosted stack runs today — and the hosted one at launch.",
    ),
    "the ingest row claims a hosted endpoint in the present tense",
  );
  assert.ok(pageText.includes("This site's documentation."));
  // Same hedge one line up: obstack RUNS a demo and a docs site; the three
  // components are what a deployment of it consists of, whoever runs it.
  assert.ok(
    pageText.includes("The components an obstack deployment runs, and the incident notices it has published."),
    "the heading sentence claims obstack runs the components itself",
  );
  // The list is rendered BY mapping the id array, so a fourth component cannot
  // appear on the page without becoming a component a notice can name.
  assert.ok(
    pageSource.includes("STATUS_COMPONENT_IDS.map("),
    "the page no longer renders the shared id list — a component could drift onto it alone",
  );
});

const MONITOR_VAR = "OBSTACK_STATUS_MONITOR_URL";

test("D342: unset — the honest default, and no monitor link on the page", async () => {
  // Rendered, not read as text (see the header comment above `flatten`): the
  // source carries both arms' JSX regardless of env, so what proves the
  // UNSET arm is what the server actually returns when the env is unset.
  delete process.env[MONITOR_VAR];
  const page = await import("@/app/status/page");
  const tree = await page.default();

  assert.equal(
    renderedText(tree).includes("This deployment publishes no external uptime monitor."),
    true,
    "the unset sentence is missing",
  );
  assert.equal(
    renderedText(tree).includes("External uptime monitoring for obstack is published at"),
    false,
    "the set-arm sentence rendered while the env was unset",
  );
  assert.deepEqual(anchorHrefs(tree), [], "an <a> to a monitor rendered with no monitor configured");
});

test("D342: set — the monitor link renders, with the host as its visible text", async () => {
  process.env[MONITOR_VAR] = "https://status.example.com/";
  const page = await import("@/app/status/page");
  const tree = await page.default();
  delete process.env[MONITOR_VAR];

  assert.equal(
    renderedText(tree).includes("External uptime monitoring for obstack is published at"),
    true,
    "the set-arm sentence did not render",
  );
  assert.equal(
    renderedText(tree).includes("This deployment publishes no external uptime monitor."),
    false,
    "the unset sentence rendered alongside the configured monitor",
  );
  assert.deepEqual(anchorHrefs(tree), ["https://status.example.com"], "the monitor link's href");
  assert.equal(renderedText(tree).includes("status.example.com"), true, "the visible link text is the host");
});

test("D324: with nothing published, the incidents section is one sentence", () => {
  assert.ok(
    pageText.includes("No incidents recorded."),
    "the empty state is gone — an empty incident history must say so, not render nothing",
  );
  // The list comes from the loader, not from a literal in the page: an
  // incident on this page is a file somebody wrote.
  assert.ok(pageSource.includes('from "@/lib/docs/incidents-load"'));
  assert.ok(pageSource.includes("await loadIncidents()"));
});

test("D324: the SLO surface no longer links here", () => {
  // `app/app/slos/page.tsx` is an M6 mock surface. Its link read "public
  // status page", which implied this page is fed by those SLOs — the exact
  // claim D256 deleted. The link is removed rather than repointed, because
  // the implication travelled with the link and not with its href.
  const slos = read("app/app/slos/page.tsx");
  assert.equal(slos.includes('"/status"'), false, "the SLO page links at /status again");
  // The offer is banned where a reader would see it — a rendered text node —
  // not everywhere the two words appear in the file. The substring ban caught
  // the removal comment as well, so the comment explaining why the link went
  // could not name the thing it was about, and the next person to read it
  // learned less than the deletion was worth. A JSX comment is `{/* … */}`, so
  // excluding braces from the text is what separates the two cases.
  const offered = [...slos.matchAll(/>([^<>{}]*status page[^<>{}]*)</gi)].map((m) => m[1].trim());
  assert.deepEqual(offered, [], "the SLO page renders text offering a status page");
  // The palette entry is the one inbound link that stays (D324): it is a
  // navigation list, and the destination is a real public page.
  const palette = read("components/shell/CommandPalette.tsx");
  assert.equal(
    palette.split('href: "/status"').length - 1,
    1,
    "the command palette must offer /status exactly once",
  );
});
