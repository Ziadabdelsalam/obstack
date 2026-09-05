import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { NOT_CONFIGURED_DETAIL, NO_EVIDENCE_DETAIL, overQuotaDetail } from "@/server/explain";

// run with: npm test --workspace apps/web
//
// THE MIRRORED PREDICATE (D206), extended to Explain — the same coupling
// `server/billing/reconcile-wording.test.ts` pins for reconciliation, restated
// for the three refusals the two Explain routes can answer with.
//
// The e2e drive splits the server log at sign-out and asserts that NO error
// line appears across every authenticated step; what counts as an error line is
// the regex below, restated from the drive's own source. An Explain run that is
// refused — no model configured (D102), or the plan's allowance spent (D225) —
// is a deliberate product outcome on an authenticated path, and the drive walks
// the over-quota one ON PURPOSE (the T7 step). Worded with "Error" in it, a
// correct behaviour would turn the run red in a file nobody would think to
// look at.
//
// What is checked: the refusal text the user reads, and every non-error line
// logged anywhere on the Explain request path — the route AND the engine behind
// it (D244: `server/explain/validate.ts` warns when it drops a model-invented
// evidence id, which happens mid-run on the same authenticated path the drive
// walks). Error-level lines are deliberately NOT checked — a provider that dies
// mid-stream is a failure we WANT the drive to see, so D193's grade is what
// separates the two: refusals log at warn, failures log at error.
const DRIVE_IS_ERROR = /Error\b|⨯|unhandledRejection/;
const DRIVE_IS_ERROR_SOURCE = String.raw`/Error\b|⨯|unhandledRejection/`;

const repoRoot = path.resolve(import.meta.dirname, "../../../../../../../..");
const drivePath = path.join(repoRoot, "deploy/compose/e2e-drive.mjs");
const explainServerDir = path.resolve(import.meta.dirname, "../../../../../server/explain");

// Both routes plus every non-test source file of the engine they call. The
// engine is read from the directory rather than listed, so a file added to it
// later is swept without anybody remembering this test exists; the routes are
// listed because they live outside it (D557: the RCA route was the first Explain
// refusal in the repo that no D206 mirror read, until this line).
const sweptPaths = [
  path.join(import.meta.dirname, "route.ts"),
  path.resolve(import.meta.dirname, "../../../incidents/[id]/rca/route.ts"),
  ...readdirSync(explainServerDir)
    .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
    .map((name) => path.join(explainServerDir, name)),
];

test("the regex is the drive's own, character for character", () => {
  const drive = readFileSync(drivePath, "utf8");
  assert.ok(
    drive.includes(DRIVE_IS_ERROR_SOURCE),
    `${drivePath} no longer carries ${DRIVE_IS_ERROR_SOURCE} — the drive's error predicate moved, and the ` +
      `Explain refusal wordings below were checked against the old one`,
  );
});

test("no refusal the user reads looks like an error line (D206)", () => {
  // The strings as EMITTED, not as written: the over-quota detail interpolates
  // the plan's quota, so it is asserted with a number in it.
  for (const detail of [NOT_CONFIGURED_DETAIL, NO_EVIDENCE_DETAIL, overQuotaDetail(20), overQuotaDetail(200)]) {
    assert.equal(
      DRIVE_IS_ERROR.test(detail),
      false,
      `this refusal reads as an error to the e2e drive's log check: ${detail}`,
    );
  }
});

test("nothing the Explain path LOGS below error level reads as an error line (D206)", () => {
  // Every non-error line in every swept file, not the ones this test was
  // written against: a second refusal added later is caught by the same run
  // rather than by somebody remembering this file exists, and it is caught
  // whichever non-error level it is written at. `console.error` is the
  // deliberate exemption above — a failure is meant to read like one. All three
  // string forms, because a line with nothing to interpolate is written with
  // quotes.
  const logged: { file: string; template: string }[] = [];
  for (const file of sweptPaths) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /console\.(?:warn|log|info|debug)\(\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')/g,
    )) {
      logged.push({ file, template: m[1] ?? m[2] ?? m[3] });
    }
  }
  assert.ok(
    logged.length >= 4,
    "fewer than the four known non-error lines (the traces route's over-quota refusal, the RCA route's " +
      "over-quota and no-evidence refusals, validate.ts's dropped reference) were found — the scan stopped matching",
  );

  for (const { file, template } of logged) {
    // Interpolations are runtime values — today the session's workspace id, the
    // only one left (D248 deleted the model-supplied one: untrusted content
    // never enters the server log at any level). A sample stands in so the line
    // is asserted in the shape it is emitted; what is pinned here is the
    // wording around it.
    const line = template.replace(/\$\{[^}]*\}/g, "ws_sample");
    assert.equal(
      DRIVE_IS_ERROR.test(line),
      false,
      `this line reads as an error to the e2e drive's log check, on an authenticated path ` +
        `(${file}): ${line}`,
    );
  }
});
