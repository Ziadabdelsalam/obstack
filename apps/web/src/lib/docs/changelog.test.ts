import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  changelogManifest,
  formatEntryDate,
  slugDate,
  sortNewestFirst,
} from "./changelog";

// run with: npm test --workspace apps/web
//
// The changelog's gate (S4.4 T3, D255/D320/D323). `/changelog` used to be a
// hardcoded array inside `app/changelog/page.tsx`; it is now dated `.mdx` files
// in the same content tree the docs live in. Four things are pinned here, and
// each is one that fails SILENTLY otherwise:
//
//   1. the manifest and the directory agree, in BOTH directions (D206 mirror
//      shape) — a file with no entry is never rendered, and an entry with no
//      file is a `Cannot find module` at prerender;
//   2. the four migrated bodies are BYTE-EQUAL to the text they had in the
//      array at `3edc49b` — the migration was a move, not a rewrite, and this
//      is what makes that checkable rather than asserted in a commit message;
//   3. a file's name and its `frontmatter.date` say the same thing, and that
//      date is the one the page sorts and prints (D323's date rule);
//   4. nothing that ships reads the filesystem or branches on the data mode.
//
// `fs` IS used below, deliberately: this file runs at test time, on the source
// tree, and its whole job is to be the one place that looks at the real
// directory so that nothing at runtime has to.

const HERE = path.dirname(import.meta.filename);
const WEB_SRC = path.resolve(HERE, "../..");
const REPO_ROOT = path.resolve(WEB_SRC, "../../..");
const CONTENT = path.join(WEB_SRC, "content/changelog");
const read = (p: string) => readFileSync(path.join(WEB_SRC, p), "utf8");

/**
 * THE BYTE PIN (D323). The four entries' bodies exactly as they stood in
 * `apps/web/src/app/changelog/page.tsx` at `3edc49b` — read out of the tree's
 * own history (`git show 3edc49b:...`) rather than retyped, so the pin is the
 * repo's record of the text and not this author's memory of it.
 *
 * These lines are deliberately not wrapped. Re-flowing a pinned string is how
 * a byte pin quietly stops pinning bytes.
 *
 * Editing one of these four entries is allowed. It just has to be DELIBERATE:
 * change the `.mdx` and change its line here in the same commit, and say why.
 */
const BODY_PINS: Record<string, string> = {
  "2026-08-20-explain-this-trace":
    "One click on a failed trace streams a root-cause summary built from that trace's own spans and the log lines on its timeline — the ones carrying its trace id and the nearby lines from the same window. Each piece of evidence links back to the span or log line it came from, and a reference the trace does not contain is dropped, with the drop stated rather than linked. The summary comes from Claude, or from whichever Anthropic-compatible endpoint a self-hosted install is pointed at; with no model configured the panel says so instead of guessing. Runs are metered per plan — 20 a month on Free, 200 on Pro.",
  "2026-08-20-connections-hub":
    "OpenTelemetry, Kubernetes and Docker as guided connections, each with the ingest health of the source it set up. The rest of the catalog is listed as coming soon, because that is what it is.",
  "2026-08-17-logs-explorer":
    "Search log bodies, and filter by minimum severity, pod and time range. Any line carrying a trace id is one click from its trace. Nothing tails: refreshing is a button.",
  "2026-08-16-traces-carry-their-logs":
    "A trace opens as its spans across every service that took part, with the log lines that share its trace id on the same timeline — plus the nearby lines from the same window, marked as nearby rather than claimed as correlated.",
};

/** The render order the page must produce: newest first, ties broken by slug descending (D323). */
const RENDER_ORDER = [
  "2026-09-21-account-page-and-workspace-switcher",
  "2026-08-20-explain-this-trace",
  "2026-08-20-connections-hub",
  "2026-08-17-logs-explorer",
  "2026-08-16-traces-carry-their-logs",
];

interface Entry {
  readonly slug: string;
  readonly file: string;
  readonly source: string;
}

/** Every `.mdx` in the directory — an entry IS a file, with no nesting. */
const onDisk: Entry[] = readdirSync(CONTENT, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".mdx"))
  .map((e) => ({
    slug: e.name.slice(0, -".mdx".length),
    file: path.join(CONTENT, e.name),
    source: readFileSync(path.join(CONTENT, e.name), "utf8"),
  }))
  .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

/** The `export const frontmatter = { … };` block, as text. */
function frontmatterBlock(source: string): string {
  const start = source.indexOf("export const frontmatter = {");
  assert.ok(start >= 0, "no `export const frontmatter` (it is a named export here, not YAML — mdx.md:622-643)");
  return source.slice(start, source.indexOf("};", start) + 2);
}

/**
 * The note itself: the file with its frontmatter export and its `merged:`
 * evidence comment removed, trimmed. Everything left is the prose that
 * renders, which is what the pin above is a pin OF.
 */
function bodyOf(source: string): string {
  const withoutFrontmatter = source.replace(frontmatterBlock(source), "");
  return withoutFrontmatter
    .split("\n")
    .filter((line) => !/^\{\/\*.*\*\/\}$/.test(line.trim()))
    .join("\n")
    .trim();
}

test("D320: the manifest and the changelog directory are the same set, both ways", () => {
  assert.deepEqual(
    onDisk.map((e) => e.slug),
    changelogManifest.map((e) => e.slug).sort(),
    "src/content/changelog/*.mdx and src/content/changelog/manifest.ts disagree — every entry needs exactly one manifest line",
  );
});

test("the directory is flat, and every entry is named for its date", () => {
  // A subdirectory here would be content the manifest cannot name and the
  // loader's single-interpolation import cannot reach — it would just sit
  // there looking published.
  const dirs = readdirSync(CONTENT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.deepEqual(dirs, [], "src/content/changelog is flat: one entry is one YYYY-MM-DD-slug.mdx file");
  assert.ok(onDisk.length > 0, "the changelog corpus is empty");
  for (const entry of onDisk) {
    assert.ok(slugDate(entry.slug), `${entry.slug}.mdx does not start with a YYYY-MM-DD date`);
  }
});

test("D323: frontmatter is complete, literal, and agrees with the file name", () => {
  // Read as text rather than imported: the suite runs under
  // `tsx --conditions react-server`, which has no MDX loader (the same reason
  // the docs corpus is checked this way). The contract is a literal in the
  // file anyway — a computed date could not be a build-time sort key either.
  for (const entry of onDisk) {
    const block = frontmatterBlock(entry.source);
    const date = /date:\s*"(\d{4}-\d{2}-\d{2})"/.exec(block)?.[1];
    const kind = /kind:\s*"([^"]+)"/.exec(block)?.[1];
    assert.ok(date, `${entry.slug}: frontmatter.date is missing or is not a "YYYY-MM-DD" string literal`);
    assert.match(block, /title:\s*"[^"]+"/, `${entry.slug}: frontmatter.title is missing or is not a plain string literal`);
    assert.ok(
      kind === "new" || kind === "improved",
      `${entry.slug}: frontmatter.kind is ${JSON.stringify(kind)} — the page has a colour for "new" and "improved" only`,
    );
    // The date rule's other half: the name and the frontmatter cannot tell
    // different stories, or the directory listing and the rendered page
    // disagree about when something shipped.
    assert.equal(
      slugDate(entry.slug),
      date,
      `${entry.slug}: the file name's date and frontmatter.date disagree`,
    );
  }
});

/** The merge evidence beside an entry's body: its sha, its PR number, its date. */
function mergeEvidence(source: string): { sha: string; pr: string; date: string } | null {
  const m = /\{\/\* merged: ([0-9a-f]{7,40}) PR #(\d+), (\d{4}-\d{2}-\d{2}) \*\/\}/.exec(source);
  return m ? { sha: m[1], pr: m[2], date: m[3] } : null;
}

test("D323: each entry names the merge that made it true", () => {
  // The date rule is "the master merge date of the PR that made the entry
  // true" (`src/content/changelog/README.md`). A date with no evidence beside
  // it is a number somebody typed; this is the evidence.
  for (const entry of onDisk) {
    const merged = mergeEvidence(entry.source);
    assert.ok(merged, `${entry.slug}: no \`{/* merged: <sha> PR #<n>, <date> */}\` comment`);
    assert.equal(
      merged.date,
      slugDate(entry.slug),
      `${entry.slug}: the merge date in the comment is not the date the entry carries`,
    );
  }
});

test("D323: the merge each entry names actually landed on the date it claims", (t) => {
  // The half the comment above cannot check by itself: a sha, a PR number and
  // a date typed on one line agree with each other by construction. This asks
  // THE REPOSITORY when that commit landed — `git log -1 --format=%cd` on the
  // sha — so a date copied from the wrong row, or a sha that never existed, is
  // caught here rather than believed forever.
  if (!existsSync(path.join(REPO_ROOT, ".git"))) {
    // Stated rather than silent: an exported or vendored copy of this tree has
    // no history to ask, and the entries are still checked against each other
    // above. Nothing about the corpus is skipped — only the question that
    // needs a repository to answer.
    //
    // On CI that is not a condition to tolerate, it is a misconfiguration
    // (S4.4 R1 should-fix A): a run with no history is a run where the only
    // check that can catch a mistyped date did not happen.
    const why = "no .git — the merge dates cannot be checked against history from this copy";
    assert.ok(!process.env.CI, why);
    t.skip(`${why} — skipped locally, fails on CI`);
    return;
  }
  for (const entry of onDisk) {
    const merged = mergeEvidence(entry.source);
    assert.ok(merged, `${entry.slug}: no merge evidence`);
    let landed: string;
    try {
      landed = execFileSync("git", ["log", "-1", "--format=%cd", "--date=short", merged.sha], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch {
      // A shallow checkout (`fetch-depth: 1`) has the files and not the
      // commits. Same rule as above: say so, do not invent a pass or a fail —
      // and on CI, refuse, because `web.yml` checks out with `fetch-depth: 0`
      // precisely so this question can be asked. This branch WAS what every CI
      // run took.
      const why =
        `${merged.sha} is not in this checkout's object store (shallow clone?) — ` +
        "this arm needs full history; .github/workflows/web.yml sets `fetch-depth: 0`";
      assert.ok(!process.env.CI, why);
      t.skip(`${why} — skipped locally, fails on CI`);
      return;
    }
    assert.equal(
      landed,
      merged.date,
      `${entry.slug}: the comment says ${merged.sha} landed ${merged.date}, but it landed ${landed}`,
    );
    assert.equal(landed, slugDate(entry.slug), `${entry.slug}: the entry is filed under a different date`);
  }
});

test("D323: the four migrated bodies are byte-equal to the text they had at 3edc49b", () => {
  // The migration off the hardcoded array was a MOVE. Anything that is not
  // byte-identical was a rewrite nobody asked for — a re-flow, a smart quote,
  // an em-dash that became a hyphen — and this is the assertion that says so
  // before the words reach a stranger.
  assert.deepEqual(
    onDisk.map((e) => e.slug).filter((slug) => slug in BODY_PINS).sort(),
    Object.keys(BODY_PINS).sort(),
    "a pinned entry is missing from the tree — delete its pin deliberately or restore the file",
  );
  for (const [slug, pinned] of Object.entries(BODY_PINS)) {
    const entry = onDisk.find((e) => e.slug === slug);
    assert.ok(entry, `${slug}.mdx is gone`);
    const body = bodyOf(entry.source);
    assert.equal(body, pinned, `${slug}: the body no longer matches the text it was migrated from`);
    assert.equal(
      Buffer.byteLength(body, "utf8"),
      Buffer.byteLength(pinned, "utf8"),
      `${slug}: same string, different bytes — that is not possible unless one of them is not what it looks like`,
    );
  }
});

/** Every ordering of a list — 5 entries is 120 of them, which is the point. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

test("D323: the page renders newest first, and the manifest is not what orders it", () => {
  // The dates come from the files, so this is the real corpus being sorted,
  // not a fixture: `sortNewestFirst` is what `loadChangelog` calls.
  //
  // The key is `frontmatter.date` READ OUT OF THE FILE, not `slugDate(slug)`.
  // The two agree — the test above requires it — but the page prints the
  // frontmatter and the loader sorts on the frontmatter, so a fixture keyed on
  // the file name would be checking the comparator against a value the product
  // never passes it (D323: the sort key is the value the page prints).
  const dated = onDisk.map((e) => {
    const date = /date:\s*"(\d{4}-\d{2}-\d{2})"/.exec(frontmatterBlock(e.source))?.[1];
    assert.ok(date, `${e.slug}: no frontmatter.date to sort on`);
    return { slug: e.slug, frontmatter: { date } };
  });
  assert.deepEqual(sortNewestFirst(dated).map((e) => e.slug), RENDER_ORDER);

  // 2026-08-20 merged two entries, so the comparator needs a TOTAL order or
  // the page's order depends on the manifest's — which the manifest does not
  // promise.
  const sameDay = RENDER_ORDER.filter((slug) => slug.startsWith("2026-08-20"));
  assert.equal(sameDay.length, 2, "the same-date tie-break is no longer exercised by the corpus");

  // EVERY input order, not one. Sorting the reversed input was vacuous: the
  // directory listing is slug-ascending, so its reverse IS the render order
  // already, and a comparator that returned 0 for every pair would have passed
  // it on a stable sort. A hundred and twenty orderings of five entries have
  // no such hiding place — the same answer from all of them is what "total
  // order" means.
  const orderings = permutations(dated);
  assert.equal(orderings.length, 120, "five entries have 120 orderings — the corpus changed size");
  for (const ordering of orderings) {
    assert.deepEqual(
      sortNewestFirst(ordering).map((e) => e.slug),
      RENDER_ORDER,
      `the sort depends on its input order: ${ordering.map((e) => e.slug).join(", ")} came out wrong`,
    );
  }

  // And the manifest is deliberately NOT in render order: if it were, a broken
  // comparator would still produce the right page.
  assert.notDeepEqual(
    changelogManifest.map((e) => e.slug),
    RENDER_ORDER,
    "manifest.ts is in render order — the sort would no longer be exercised by the build (see the comment in that file)",
  );
});

test("dates print without a Date, a locale or a zone", () => {
  assert.equal(formatEntryDate("2026-08-20"), "Aug 20, 2026");
  assert.equal(formatEntryDate("2026-08-06"), "Aug 6, 2026");
  assert.equal(formatEntryDate("2026-01-31"), "Jan 31, 2026");
  assert.equal(formatEntryDate("2026-12-01"), "Dec 1, 2026");
  // A `YYYY-MM-DD` string is a calendar date with no time in it; round-tripping
  // it through `Date` would make the printed day depend on where the build ran.
  assert.throws(() => formatEntryDate("2026-13-01"), /not a YYYY-MM-DD date/);
  assert.throws(() => formatEntryDate("Aug 20, 2026"), /not a YYYY-MM-DD date/);
});

// Everything the changelog route reaches that is not framework code.
const SHIPPED_SOURCES: Record<string, string> = {
  "lib/docs/changelog.ts": read("lib/docs/changelog.ts"),
  "lib/docs/changelog-load.ts": read("lib/docs/changelog-load.ts"),
  "content/changelog/manifest.ts": read("content/changelog/manifest.ts"),
  "app/changelog/page.tsx": read("app/changelog/page.tsx"),
  ...Object.fromEntries(onDisk.map((e) => [`content/changelog/${e.slug}.mdx`, e.source])),
};

/**
 * The three edges a mode-blind route may not have, assembled at run time
 * rather than written out.
 *
 * Same discipline as the D246 sweep's needle in
 * `components/shell/TourGuide.test.ts`: the audit that proves this corpus is
 * mode-blind is a `grep` over `content/changelog/`, `lib/docs/changelog*` and
 * `app/changelog/` — which reaches THIS file — so a test that spelled the
 * banned import out would be the first hit of the grep it exists to keep
 * empty. A checker that cannot survive its own check is not one to trust.
 */
const BANNED_EDGES: Record<string, string> = {
  "a mock module": ["@", "mock", ""].join("/"),
  "the data-mode helper": ["resolve", "Mode"].join(""),
  "the data-mode field": ["data", "Mode"].join(""),
};

test("the changelog is mode-blind — no mock edge, no mode branch", () => {
  // D251/D267: the `live` and `mock` web images are ONE build with a
  // build-time stamp between them, so both must serve the same release notes.
  // The way that stops being true is not a decision anyone records — it is an
  // import that arrives in a refactor.
  for (const [name, source] of Object.entries(SHIPPED_SOURCES)) {
    for (const [what, literal] of Object.entries(BANNED_EDGES)) {
      assert.equal(source.includes(literal), false, `${name} names ${what}`);
    }
  }
});

test("D320: no module that ships reads the filesystem", () => {
  for (const [name, source] of Object.entries(SHIPPED_SOURCES)) {
    for (const banned of ['from "fs"', "from 'fs'", "node:fs", "node:path", 'from "path"', "readdirSync", "readFileSync"]) {
      assert.equal(source.includes(banned), false, `${name} reaches the filesystem (${banned})`);
    }
  }
});

test("the dynamic import stays one interpolation of one variable", () => {
  // Measured on next 16.3.0 during T1: a NESTED template in the import
  // compiles and then fails at PRERENDER with `Cannot find module`, because
  // Turbopack builds the context module out of the template's literal parts.
  // The changelog gets this for free today — an entry's file name is its slug
  // — which is exactly why it is pinned: nothing about the current form
  // announces that it is load-bearing.
  assert.ok(
    SHIPPED_SOURCES["lib/docs/changelog-load.ts"].includes(
      "await import(`@/content/changelog/${entry.slug}.mdx`)",
    ),
    "the dynamic import is no longer a single interpolation of a plain variable",
  );
});
