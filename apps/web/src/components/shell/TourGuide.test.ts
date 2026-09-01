import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// D60: the product tour annotates `/app/logs`, which now reads `obstack.logs`
// in live mode, so the step's words are a claim about real data — and it used
// to promise a tail plus a named pod inventory (D48 killed the tail; the pod
// list is whatever the workspace logged). This file guards the repaired copy
// and sweeps the whole repo for the claim coming back anywhere else.
//
// Text, not import: TourGuide is a `"use client"` component and the runner is
// pinned to `--conditions react-server`, which cannot load one (D54(ii)).

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Repo root, derived from THIS file rather than from cwd, so the sweep covers the same tree wherever the runner was started (S2.2 L3). */
const REPO_ROOT = path.resolve(HERE, "../../../../..");

const TOUR_GUIDE = path.join(HERE, "TourGuide.tsx");
const LOGS_EXPLORER = path.join(HERE, "../logs/LogsExplorer.tsx");
const COMPONENTS = path.resolve(HERE, "..");

/**
 * The claim, never written out as a literal in this file: the sweep below reads
 * every checked-in source, INCLUDING this one, so a spelled-out needle would
 * match itself and make the result a lie (S2.2 L4 — a sweep is only as good as
 * its own text-ness). Both spellings are hunted.
 *
 * Matching is CASE-INSENSITIVE and that is load-bearing, not tidiness (D67(ii)):
 * UI copy arrives Title-Cased, so a case-sensitive sweep would miss the claim
 * the moment it came back as a heading — which is how it survived the first
 * time. Until S4.4 the file that proved this was a real hit in the tree with a
 * capital letter in it; there is no such file any more, so the proof is BUILT
 * instead, at the end of the sweep, and it runs through `foldedMatches` — the
 * same function the sweep filters with (R1). (This paragraph must never spell
 * the phrase out: the sweep reads this file too.)
 */
const CLAIM = ["live", "tail"];
const NEEDLES = [CLAIM.join(" "), CLAIM.join("-")];

/**
 * EMPTY, as of S4.4 T5 (D325 class 6). The last entry was a landing-page
 * screenshot blurb that annotated no wired surface — M3-deferred under the
 * widened D63 item, and the one file that pinned the claim in place rather than
 * banning it. Its copy now describes the search the surface performs, so the
 * sweep has nothing left to excuse: EVERY hit in the repo is a regression.
 *
 * The changelog left this list when its copy was repaired (D246); its release
 * notes are `.mdx` under `src/content/changelog/`, and the prose that explains
 * what they may not claim (`src/content/changelog/README.md`) describes the
 * claim instead of spelling it, so the sweep guards those files like any other.
 *
 * Nothing below fails on an empty list — see the fold proof at the end of the
 * sweep, which was made synthetic (D323) for exactly this moment.
 */
const ALLOWED: string[] = [];

/**
 * Generated or vendored trees, plus `.planning`: the planning record quotes the
 * old copy verbatim to rule it out, so sweeping it would be red by construction.
 * Symlinks are neither followed nor counted — this repo checks none in.
 */
const SKIP_DIRS = new Set([".git", ".next", "node_modules", ".planning"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

test("D60 sweep: the tail claim survives nowhere in the repo", () => {
  const scanned = walk(REPO_ROOT);
  // If the walk ever breaks early the assertion below would pass by finding
  // nothing, so the file count is asserted too — the sweep has to have read a
  // repo-sized tree before its silence means anything (S2.0 L1).
  assert.ok(scanned.length > 200, `the sweep only reached ${scanned.length} files — it is not walking the repo`);

  const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
  const matches = (text: string) => NEEDLES.some((needle) => text.includes(needle));
  /**
   * THE folded predicate — one definition, used by the sweep below AND by the
   * fold proof at the end of this test. Two spellings of "fold the text, then
   * look" is how a guard comes to guard nothing: written inline at each call
   * site, the proof exercised `String.prototype.toLowerCase` and said nothing
   * whatever about whether the SWEEP still folded. Deleting the fold here now
   * turns the proof red, which is the only arrangement in which it is a proof.
   */
  const foldedMatches = (text: string) => matches(text.toLowerCase());

  // D323 — the coverage survived the move. The changelog's four entries were a
  // hardcoded array in `app/changelog/page.tsx` and the docs were a module
  // under `src/mock/`; both are now `.mdx` under `src/content/**`. That tree is
  // swept for one reason only: it is not on SKIP_DIRS. Which is a property of
  // THIS file, not of the corpus — a `content` entry added to the skip list, or
  // a corpus moved under a generated directory, would silently take the
  // product's most public prose out of the sweep's reach. So the sweep is made
  // to prove it read that prose before its silence means anything.
  const scannedRel = scanned.map(rel);
  for (const dir of ["apps/web/src/content/changelog/", "apps/web/src/content/docs/"]) {
    assert.ok(
      scannedRel.some((file) => file.startsWith(dir)),
      `the sweep read no file under ${dir} — the corpus that makes this product's claims to strangers is outside its coverage`,
    );
  }

  const hits = scanned
    .filter((file) => foldedMatches(readFileSync(file, "utf8")))
    .map(rel)
    .sort();

  assert.deepEqual(
    hits,
    [...ALLOWED].sort(),
    "the tail claim appeared somewhere new (or a named exception was repaired without updating this list) — nothing that describes a wired surface may claim a tail (D48/D60)",
  );

  // D67(ii), reshaped by D323: the fold is not cosmetic, and here is the proof
  // — built, not found.
  //
  // This used to assert that the case-SENSITIVE hit set differed from the
  // case-insensitive one, which said something real only while some file in
  // the repo happened to spell the claim with a capital letter. The last such
  // file is the one entry in ALLOWED, and it goes in S4.4 T5: with an empty
  // allowlist both sets are empty and `notDeepEqual([], [])` fails BY
  // CONSTRUCTION. The guard against a hollow guard would then have to be
  // deleted at exactly the moment the sweep first had nothing to find, which
  // is the wrong direction for a test to move.
  //
  // So the fixture is synthetic: the claim, upper-cased at run time — never
  // spelled in this file, which the sweep also reads — is INVISIBLE to the raw
  // predicate and VISIBLE once folded, in both of its spellings. That is
  // precisely what `foldedMatches` above buys, asserted directly, and it holds
  // whether the allowlist has one entry or none.
  //
  // It is asserted THROUGH `foldedMatches`, the same function the sweep filters
  // with, and that is the whole of the guard: an inline `.toLowerCase()` here
  // would fold the fixture with the language's own method and pass no matter
  // what the sweep did — green with the sweep's fold deleted and a shouted
  // spelling of the claim planted in the tree, which is exactly the failure
  // this test exists to make impossible.
  for (const needle of NEEDLES) {
    const shouted = `## ${needle.toUpperCase()} — the way UI copy actually gets written`;
    assert.equal(
      foldedMatches(shouted),
      true,
      "the folded sweep no longer sees a shouted spelling of the claim — the fold has stopped doing anything",
    );
    assert.equal(
      matches(shouted),
      false,
      "the raw predicate already sees a shouted spelling — the needles are no longer lower-case, so the fold above is silently doing nothing",
    );
  }

  // The other half of D67(ii): whatever a case-sensitive sweep of the real tree
  // finds must be a subset of what the folded one found. Vacuous on a clean
  // repo, and correct on a dirty one — the assertion that would catch a fold
  // that had somehow started HIDING files.
  const caseSensitiveHits = scanned.filter((file) => matches(readFileSync(file, "utf8"))).map(rel).sort();
  for (const hit of caseSensitiveHits) {
    assert.ok(hits.includes(hit), `${hit} matched case-sensitively but not case-insensitively — impossible`);
  }
});

test("D60: the /app/logs tour step promises capability, not a tail or a pod inventory", () => {
  const source = readFileSync(TOUR_GUIDE, "utf8");
  const start = source.indexOf('path: "/app/logs"');
  assert.ok(start > 0, "the tour no longer has an /app/logs step — the wired surface lost its annotation");
  const step = source.slice(start, source.indexOf("},", start));

  // The removed inventory: named pods the surface cannot promise in any
  // workspace. The tail claim itself is covered by the repo sweep above.
  for (const pod of ["kubelet", "cert-manager", "postgres"]) {
    assert.ok(!step.includes(pod), `the logs tour step still names ${pod} — the pod list is whatever the workspace logged`);
  }
  // What the step must still do: point at the surface's anchor and describe the
  // one capability the copy is here to teach.
  assert.ok(step.includes('target: "logs"'), "the step stopped targeting the logs anchor");
  assert.ok(step.includes("TRACE"), "the step stopped describing the TRACE click-through");
  assert.ok(
    readFileSync(LOGS_EXPLORER, "utf8").includes('data-tour="logs"'),
    "LogsExplorer dropped data-tour=\"logs\", so the step spotlights nothing on the wired surface",
  );
});

/**
 * One step's source, sliced out of the array the way the `/app/logs` test above
 * does it — the tour is a `"use client"` module the react-server runner cannot
 * import (D54(ii)), so the copy is read as text.
 */
function stepSource(path: string): string {
  const source = readFileSync(TOUR_GUIDE, "utf8");
  const start = source.indexOf(`path: "${path}"`);
  assert.ok(start > 0, `the tour no longer has a ${path} step — the wired surface lost its annotation`);
  return source.slice(start, source.indexOf("},", start));
}

/**
 * S6.2 (D404): `/app/map`, `/app/issues` and `/app/users` read the signed-in
 * workspace's own spans in live mode now, so each step's words became a claim
 * about REAL data — and all three were narrating the sample incident: the red
 * edge returning 429 at 13:05, the 429 group spiking in the last bucket, and a
 * named customer's account absorbing 41 failures. None of that is true of a
 * workspace that just connected an exporter.
 *
 * The three tests below are the `/app/logs` test's shape, one per surface (the
 * D60 treatment): the demo's facts are gone, the step still names its anchor,
 * and BOTH components behind the route still carry that anchor — the live one
 * and the frozen mock one, because the tour walks the same step in both modes
 * and a step that spotlights nothing is a card floating over a screen.
 */
const surfaceFile = (relative: string) => readFileSync(path.join(COMPONENTS, relative), "utf8");

test("D404: the /app/map tour step promises capability, not the demo's incident edge", () => {
  const step = stepSource("/app/map");
  for (const fact of ["8.1", "429", "13:05", "LLM provider"]) {
    assert.ok(!step.includes(fact), `the map tour step still narrates "${fact}" — a fact about the demo fixture, not about a live workspace`);
  }
  assert.ok(step.includes('target: "map"'), "the step stopped targeting the map anchor");
  assert.ok(step.includes("error rate"), "the step stopped describing what an edge carries");
  for (const file of ["map/ServiceMapLive.tsx", "map/ServiceMapMock.tsx"]) {
    assert.ok(surfaceFile(file).includes('data-tour="map"'), `${file} dropped data-tour="map", so the step spotlights nothing there`);
  }
});

test("D404: the /app/issues tour step promises capability, not the demo's 429 group", () => {
  const step = stepSource("/app/issues");
  for (const fact of ["429", "Same incident", "spiking"]) {
    assert.ok(!step.includes(fact), `the issues tour step still narrates "${fact}" — a fact about the demo fixture, not about a live workspace`);
  }
  assert.ok(step.includes('target: "issues"'), "the step stopped targeting the issues anchor");
  // D361: this build stores no triage state, so the step says so rather than
  // implying a workflow the surface does not have.
  assert.ok(step.includes("acknowledged"), "the step stopped saying that nothing here is acknowledged (D361)");
  for (const file of ["issues/IssuesLive.tsx", "issues/IssuesMock.tsx"]) {
    assert.ok(surfaceFile(file).includes('data-tour="issues"'), `${file} dropped data-tour="issues", so the step spotlights nothing there`);
  }
});

test("D404: the /app/users tour step promises capability, not a named customer's failure count", () => {
  const step = stepSource("/app/users");
  for (const fact of ["Meridian", "41", "ops account"]) {
    assert.ok(!step.includes(fact), `the users tour step still narrates "${fact}" — a fact about the demo fixture, not about a live workspace`);
  }
  assert.ok(step.includes('target: "users"'), "the step stopped targeting the users anchor");
  assert.ok(step.includes("last failure"), "the step stopped describing the click-through to the failing trace");
  for (const file of ["users/UsersLive.tsx", "users/UsersMock.tsx"]) {
    assert.ok(surfaceFile(file).includes('data-tour="users"'), `${file} dropped data-tour="users", so the step spotlights nothing there`);
  }
});

/** Comments stripped, so a future explanatory comment quoting the old demo
 * figures cannot pass this guard by hiding them outside the step's live text. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("D404 (S6.4): the /app/costs tour step promises capability, not the demo's customer economics", () => {
  const step = stripComments(stepSource("/app/costs"));
  for (const fact of ["Meridian", "$84", "$299", "44%", "draft_reply"]) {
    assert.ok(!step.includes(fact), `the costs tour step still narrates "${fact}" — a fact about the demo fixture, not about a live workspace`);
  }
  assert.ok(step.includes('target: "costs"'), "the step stopped targeting the costs anchor");
  assert.ok(step.includes("unpriced"), "the step stopped naming unpriced calls, never shown as free (D461)");
  for (const file of ["costs/CostsLive.tsx", "costs/CostsMock.tsx"]) {
    assert.ok(surfaceFile(file).includes('data-tour="costs"'), `${file} dropped data-tour="costs", so the step spotlights nothing there`);
  }
});
