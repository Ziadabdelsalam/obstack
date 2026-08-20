import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * THE MIRRORED PREDICATE (D206) — the coupling `reconcile.ts` and the e2e drive
 * have to each other and could not see.
 *
 * The drive splits the server log at sign-out and asserts that NO error line
 * appears across every authenticated step (`deploy/compose/e2e-drive.mjs`, "the
 * server log: clean everywhere"); what counts as an error line is the regex
 * below, restated here. Reconciliation's refusals are deliberate, spec'd log
 * lines emitted on an authenticated path — a return from a checkout the rail
 * never issued is a thing the drive walks on purpose — so any of them worded
 * with "Error" in it would turn a correct product behaviour into a red run in a
 * file nobody would think to look at.
 *
 * S3.3's integrator recorded that coupling as a convention; a convention nobody
 * can read is not one, so it is a test. The regex is pinned against the drive's
 * own source (the `FLUSH_MS` mirror pattern): change it there and this goes red
 * in the same round, which is the moment to re-check the wordings below.
 */
const DRIVE_IS_ERROR = /Error\b|⨯|unhandledRejection/;
const DRIVE_IS_ERROR_SOURCE = String.raw`/Error\b|⨯|unhandledRejection/`;

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const drivePath = path.join(repoRoot, "deploy/compose/e2e-drive.mjs");
const reconcilePath = path.join(import.meta.dirname, "reconcile.ts");

test("the regex is the drive's own, character for character", () => {
  const drive = readFileSync(drivePath, "utf8");
  assert.ok(
    drive.includes(DRIVE_IS_ERROR_SOURCE),
    `${drivePath} no longer carries ${DRIVE_IS_ERROR_SOURCE} — the drive's error predicate moved, and the ` +
      `refusal wordings below were checked against the old one`,
  );
});

test("no refusal reconcile.ts logs reads as an error line to the drive", () => {
  const source = readFileSync(reconcilePath, "utf8");
  // Every logged template in the file, not the four this test was written
  // against: a fifth refusal added later is swept by the same run rather than by
  // somebody remembering this file exists.
  const logged = [...source.matchAll(/console\.(?:error|warn|log|info)\(\s*`([^`]*)`/g)].map((m) => m[1]);
  assert.ok(logged.length >= 4, `only ${logged.length} logged line(s) found — the scan stopped matching`);

  for (const template of logged) {
    // The interpolations are ids the rail supplies, already quoted and escaped
    // by `quoteId`; a sample stands in so the line is asserted as it is EMITTED.
    const line = template.replace(/\$\{[^}]*\}/g, '"chk_sample"');
    assert.equal(
      DRIVE_IS_ERROR.test(line),
      false,
      `this line reads as an error to the e2e drive's log check, on an authenticated path: ${line}`,
    );
  }
});
