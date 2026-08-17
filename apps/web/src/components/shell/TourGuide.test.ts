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

/**
 * The claim, never written out as a literal in this file: the sweep below reads
 * every checked-in source, INCLUDING this one, so a spelled-out needle would
 * match itself and make the exception list a lie (S2.2 L4 — a sweep is only as
 * good as its own text-ness). Both spellings are hunted.
 *
 * Matching is CASE-INSENSITIVE and that is load-bearing, not tidiness (D67(ii)):
 * one of the two surviving hits spells the claim with a capital L, so a
 * case-sensitive sweep silently misses it — and would then also miss the claim
 * coming back as a Title-Cased heading, which is exactly how UI copy gets
 * written. `caseSensitiveHits` below proves that difference is real rather than
 * trusting the fold to matter. (This paragraph must never spell the phrase out:
 * the sweep reads this file too.)
 */
const CLAIM = ["live", "tail"];
const NEEDLES = [CLAIM.join(" "), CLAIM.join("-")];

/**
 * Marketing fiction, both M3-deferred (the widened D63 item): a landing-page
 * screenshot blurb and a fake product changelog entry, neither of which
 * annotates a wired surface. Every OTHER hit in the repo is a regression.
 */
const ALLOWED = [
  "apps/web/src/app/changelog/page.tsx",
  "apps/web/src/components/marketing/ScreensShowcase.tsx",
];

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

test("D60 sweep: the tail claim survives only in the two named marketing files", () => {
  const scanned = walk(REPO_ROOT);
  // If the walk ever breaks early the assertion below would pass by finding
  // nothing, so the file count is asserted too — the sweep has to have read a
  // repo-sized tree before its silence means anything (S2.0 L1).
  assert.ok(scanned.length > 200, `the sweep only reached ${scanned.length} files — it is not walking the repo`);

  const rel = (file: string) => path.relative(REPO_ROOT, file).split(path.sep).join("/");
  const matches = (text: string) => NEEDLES.some((needle) => text.includes(needle));

  const hits = scanned
    .filter((file) => matches(readFileSync(file, "utf8").toLowerCase()))
    .map(rel)
    .sort();

  assert.deepEqual(
    hits,
    [...ALLOWED].sort(),
    "the tail claim appeared somewhere new (or a named exception was repaired without updating this list) — nothing that describes a wired surface may claim a tail (D48/D60)",
  );

  // D67(ii): the fold is not cosmetic. A case-SENSITIVE sweep of the same tree
  // sees strictly fewer files than the one above, so it would report a repo
  // already clean of a claim that is still on a page — this asserts the gap
  // exists rather than trusting the `.toLowerCase()` call to matter.
  const caseSensitiveHits = scanned.filter((file) => matches(readFileSync(file, "utf8"))).map(rel).sort();
  assert.notDeepEqual(
    caseSensitiveHits,
    hits,
    "a case-sensitive sweep found the same set — the case-insensitivity D67(ii) requires is no longer being exercised by any fixture, so this guard has gone hollow",
  );
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
