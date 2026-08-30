import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INCIDENT_FILE_PATTERN,
  INCIDENT_STATUSES,
  STATUS_COMPONENT_IDS,
  incidentsManifest,
  parseIncidentFrontmatter,
  sortIncidents,
  type IncidentNotice,
} from "./incidents";

// run with: npm test --workspace apps/web
//
// The incident mechanism behind `/status` (S4.4 T4, D256/D324). The page's
// honesty rests on three properties that all fail SILENTLY if nothing pins
// them:
//
//   1. the manifest and the directory agree in BOTH directions (D206 mirror
//      shape) — a notice with no entry is never published, and an entry with
//      no file is a `Cannot find module` at prerender;
//   2. order is by the date the notice CARRIES, newest first — a back-filled
//      notice appended to the manifest must not land at the bottom of the page;
//   3. the frontmatter contract is enforced where the module is read, not
//      trusted — a computed import cannot be typed, so `parseIncidentFrontmatter`
//      is the only thing between a malformed notice and a heading rendering
//      `undefined`.
//
// The directory ships EMPTY, so most of this is driven by fixtures the test
// builds itself. That is deliberate: a fixture notice committed under
// `src/content/status/incidents/` to make a test green would be published on
// the real page, which is exactly the fiction D256 deleted.
//
// `fs` IS used below, deliberately: this file runs at test time, on the source
// tree, and its job is to be the one place that looks at the real directory so
// that nothing at runtime has to (D320).

const HERE = path.dirname(import.meta.filename);
const WEB_SRC = path.resolve(HERE, "../..");
const INCIDENTS_DIR = path.join(WEB_SRC, "content/status/incidents");

/**
 * Every notice in a directory, discovered the way the manifest names them: a
 * notice IS a top-level `.mdx` file, and its key is the file name without the
 * extension (`src/content/status/incidents/README.md`).
 *
 * Takes the directory as an argument rather than closing over the real one, so
 * the same walk can be run against a fixture directory below — the mirror
 * assertion is only worth anything if it is shown to go red on a discrepancy,
 * and with both sides legitimately empty today it cannot show that on the real
 * tree (the `notDeepEqual([], [])` trap D323 names).
 */
function noticeFilesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".mdx"))
    .map((e) => e.name.slice(0, -".mdx".length))
    .sort();
}

const manifested = incidentsManifest.map((e) => e.file).sort();

test("D324: the manifest and the incident directory are the same set, both ways", () => {
  // The directory has to EXIST for its emptiness to mean anything: a renamed
  // or moved tree would otherwise make this pass by having nothing to read.
  assert.ok(existsSync(INCIDENTS_DIR), "src/content/status/incidents is gone");
  assert.ok(existsSync(path.join(INCIDENTS_DIR, "manifest.ts")), "the manifest is gone");
  assert.ok(existsSync(path.join(INCIDENTS_DIR, "README.md")), "the contract README is gone");

  assert.deepEqual(
    noticeFilesIn(INCIDENTS_DIR),
    manifested,
    "src/content/status/incidents/** and its manifest.ts disagree — every notice needs exactly one entry",
  );
});

test("the shipped manifest is empty at launch; publishing a notice means updating this pin deliberately", () => {
  // THE LAUNCH STATE, in ONE place. Both halves of it were previously asserted
  // inside tests about other things — the mirror above, and the sort below —
  // where a perfectly valid first notice would have turned two unrelated tests
  // red with messages about mirrors and sorting. Here the red says what it
  // means: obstack has published no incident notice yet, so `/status` reads
  // "No incidents recorded." because that is TRUE, not because a file is
  // missing. When the first notice ships, this test is the one line to change,
  // and changing it is a decision somebody makes on purpose.
  assert.deepEqual(manifested, [], "a notice was published — check the page's empty state is still right");
  // The same state as the loader sees it: an empty manifest resolves to an
  // empty list, so the page's `notices.length === 0` arm is the one that runs.
  assert.deepEqual(sortIncidents(incidentsManifest.map((e) => notice(e.file, "2026-01-01"))), []);
});

test("the mirror would go red on a notice with no manifest entry", () => {
  // D323's hollowness guard, applied here: with both sides empty the
  // assertion above passes by construction, so the comparison it makes is
  // exercised against a directory that DOES hold a notice. Built in a temp
  // directory — never in the real tree, which stays empty.
  const dir = mkdtempSync(path.join(tmpdir(), "obstack-incidents-"));
  // A name no manifest will ever carry, so this stays a check on the MIRROR
  // after the first real notice ships: with a plausible fixture name, the day
  // somebody published a notice of that name this test would go red saying
  // "the mirror is hollow", which is not what would have happened.
  const stray = "2999-12-31-not-a-real-notice";
  assert.equal(manifested.includes(stray), false, `${stray} is in the manifest — pick another fixture name`);
  try {
    writeFileSync(
      path.join(dir, `${stray}.mdx`),
      'export const frontmatter = {\n  date: "2999-12-31",\n  title: "A notice",\n  status: "resolved",\n  components: ["ingest"],\n};\n\nWhat happened.\n',
    );
    // Non-`.mdx` neighbours are not notices — the real directory holds two.
    writeFileSync(path.join(dir, "README.md"), "not a notice\n");
    assert.deepEqual(noticeFilesIn(dir), [stray]);
    assert.notDeepEqual(
      noticeFilesIn(dir),
      manifested,
      "a directory holding an unmanifested notice compared equal to the manifest — the mirror is hollow",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The files a manifest source registers, read off its `import()` literals.
 *
 * Each entry names its file twice — as `file` and inside `import("./….mdx")` —
 * because the specifier cannot be computed (a computed one makes Turbopack
 * glob this directory, and an empty directory then fails the build; the note
 * is in `manifest.ts`). Naming a thing twice is a chance to name it wrong, so
 * the two are compared. Takes the SOURCE as an argument so the check can be
 * driven with a fixture: with the real manifest empty it would otherwise be an
 * assertion about nothing (D323's hollowness trap).
 */
function importedFilesIn(manifestSource: string): string[] {
  // Comments first: the manifest shows the shape of an entry in a commented
  // example, and an example is not a registration. Block comments go too, so a
  // docblock that gains one later cannot publish a notice by describing it.
  const code = manifestSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/load:\s*\(\)\s*=>\s*import\("\.\/(.+?)\.mdx"\)/g)]
    .map((m) => m[1])
    .sort();
}

test("D324: every entry imports the file it claims to be", () => {
  const source = readFileSync(path.join(INCIDENTS_DIR, "manifest.ts"), "utf8");
  assert.deepEqual(
    importedFilesIn(source),
    manifested,
    "an entry's import() names a different file than its `file`",
  );

  // With the manifest empty the assertion above compares `[]` with `[]`, so
  // the comparison it makes is exercised on fixtures instead (D323's
  // hollowness trap): one entry that agrees with itself, one that does not.
  const agrees = '{ file: "2026-09-14-a", load: () => import("./2026-09-14-a.mdx") },';
  const disagrees = '{ file: "2026-09-14-a", load: () => import("./2026-09-30-b.mdx") },';
  assert.deepEqual(importedFilesIn(agrees), ["2026-09-14-a"]);
  assert.deepEqual(importedFilesIn(disagrees), ["2026-09-30-b"]);
  assert.notDeepEqual(
    importedFilesIn(disagrees),
    ["2026-09-14-a"],
    "a mismatched entry compared equal — the check is hollow",
  );
  // The manifest's own worked example must not read as a registration: that is
  // the difference between "here is the shape" and "this happened".
  assert.deepEqual(importedFilesIn(`//   ${agrees}`), [], "a commented example was read as a published notice");
  assert.deepEqual(
    importedFilesIn(["/**", ` * ${agrees}`, " */"].join("\n")),
    [],
    "a docblock example was read as a published notice",
  );
});

/** A fixture notice, in memory — the shape `incidents-load.ts` hands the page. */
function notice(file: string, date: string, title = "A notice"): IncidentNotice {
  return { file, frontmatter: { date, title, status: "resolved", components: ["ingest"] } };
}

test("notices render newest first, by the date each one carries", () => {
  // Manifest order is authoring order. A notice written today about last
  // month's incident is appended to the manifest, and it must still sort into
  // its place — ordering by the array would silently bury it.
  const sorted = sortIncidents([
    notice("2026-09-14-b", "2026-09-14"),
    notice("2026-11-02-c", "2026-11-02"),
    notice("2026-09-30-a", "2026-09-30"),
  ]);
  assert.deepEqual(
    sorted.map((n) => n.frontmatter.date),
    ["2026-11-02", "2026-09-30", "2026-09-14"],
  );
  // The whole notice travels, not just its date: the page reads every field
  // off what comes back.
  assert.deepEqual(sorted[0], notice("2026-11-02-c", "2026-11-02"));
  assert.equal(sorted[0].frontmatter.title, "A notice");
  assert.equal(sorted[0].frontmatter.status, "resolved");
  assert.deepEqual(sorted[0].frontmatter.components, ["ingest"]);
});

test("sorting an empty list does not invent one", () => {
  // The pure half of the empty state: nothing about the shipped manifest, so
  // this stays green on the day a notice is published (the launch-state pin
  // above is the one that must be updated then).
  assert.deepEqual(sortIncidents([]), [], "the empty state must stay empty");
});

test("two notices dated the same day keep the manifest's order, and the input is not mutated", () => {
  const input = [notice("2026-09-14-first", "2026-09-14"), notice("2026-09-14-second", "2026-09-14")];
  const frozen = input.map((n) => n.file);
  assert.deepEqual(
    sortIncidents(input).map((n) => n.file),
    ["2026-09-14-first", "2026-09-14-second"],
    "the sort is not stable — a date tie must fall back to the order the manifest lists",
  );
  assert.deepEqual(input.map((n) => n.file), frozen, "sortIncidents reordered its argument");
});

const GOOD = {
  date: "2026-09-14",
  title: "Delayed ingest for OTLP traces",
  status: "resolved",
  components: ["ingest", "app"],
};

test("the frontmatter contract is enforced, field by field", () => {
  const fm = parseIncidentFrontmatter("2026-09-14-ingest-backlog", GOOD);
  assert.equal(fm.date, "2026-09-14");
  assert.equal(fm.title, "Delayed ingest for OTLP traces");
  assert.equal(fm.status, "resolved");
  assert.deepEqual(fm.components, ["ingest", "app"]);

  const rejects: [string, unknown, string][] = [
    ["2026-09-14-x", undefined, "no frontmatter export at all"],
    ["2026-09-14-x", { ...GOOD, date: "14/09/2026" }, "a date that is not YYYY-MM-DD"],
    ["2026-09-14-x", { ...GOOD, date: "2026-09-15" }, "a date the file name contradicts"],
    ["2026-09-14-x", { ...GOOD, title: "" }, "an empty title"],
    ["2026-09-14-x", { ...GOOD, status: "degraded" }, "a status outside the three"],
    ["2026-09-14-x", { ...GOOD, components: [] }, "a notice affecting nothing"],
    ["2026-09-14-x", { ...GOOD, components: ["database"] }, "a component the page does not list"],
    ["ingest-backlog", GOOD, "a file name with no date in front"],
    ["2026-09-14-Ingest", GOOD, "an upper-case file name"],
  ];
  for (const [file, value, why] of rejects) {
    assert.throws(
      () => parseIncidentFrontmatter(file, value),
      /src\/content\/status\/incidents\//,
      `${why} was accepted`,
    );
  }
});

test("the ids a notice may name are the ids the status page lists", () => {
  // One definition (D324): the page renders this array, and a notice's
  // `components` is checked against it. Both directions matter — an id here
  // that the page does not render would let a notice point at nothing.
  assert.deepEqual([...STATUS_COMPONENT_IDS], ["app", "ingest", "docs"]);
  assert.deepEqual([...INCIDENT_STATUSES], ["investigating", "monitoring", "resolved"]);
  // The file-name pattern is what ties a notice's URL-ish name to its date.
  assert.ok(INCIDENT_FILE_PATTERN.test("2026-09-14-ingest-backlog"));
  assert.equal(INCIDENT_FILE_PATTERN.test("2026-9-14-x"), false);
  assert.equal(INCIDENT_FILE_PATTERN.test("2026-09-14"), false, "a notice needs a slug, not just a date");
});
