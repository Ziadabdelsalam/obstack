import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// S7.2 T5's guards for /app/changes, read from SOURCE (the alerts
// `page.test.ts` precedent, D431/D438): the mock branch pays nothing and
// renders master's page body byte for byte; the live graph never reaches back
// into the mock product; the fenced-out mock story (the INC-42 badge, the
// product-internal links) is ABSENT from the live surface (D13, packet §0);
// the flip itself is asserted at the registry (`live-routes.test.ts`), not
// here (S2.0 L1).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");

const PAGE = read("page.tsx");

const componentPath = (name: string) =>
  path.join(HERE, `../../../components/changes/${name}.tsx`);
const component = (name: string) => readFileSync(componentPath(name), "utf8");
const MOCK = component("ChangesMock");
const LIVE = component("ChangesLive");

/** Comments stripped, so a claim below is a claim about the CODE (the
 *  services guard's idiom): the live file documents the very words it must
 *  not render. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("the mock branch returns before the first await (D431)", () => {
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <ChangesMock \/>;/,
    "the mock branch must return ChangesMock with no props, and nothing else",
  );
  const body = code(PAGE);
  const branch = body.indexOf('if (dataMode !== "live")');
  const firstAwait = body.indexOf("await ");
  assert.ok(branch >= 0, "page.tsx must branch on dataMode");
  assert.ok(firstAwait >= 0, "page.tsx has no live-only await — the guard would pass vacuously");
  assert.ok(
    firstAwait > branch,
    "page.tsx runs an await before its mock branch — mock mode would pay for a live-only read",
  );
});

test("ChangesMock is master's page body, byte for byte, modulo the export line (D438/D502)", () => {
  // The pin is the sha256 of the file as `master` holds it. Regenerate with:
  //   git show master:apps/web/src/app/app/changes/page.tsx | shasum -a 256
  // Diff a failure:
  //   diff <(git show master:apps/web/src/app/app/changes/page.tsx) \
  //        src/components/changes/ChangesMock.tsx
  const moved = "export function ChangesMock() {";
  const original = "export default function ChangesPage() {";

  // Master's changes page was a SERVER component (no "use client") — the
  // moved body must stay one.
  assert.ok(!MOCK.includes('"use client"'), "ChangesMock must stay the server body it was");
  assert.ok(MOCK.includes(moved), `ChangesMock must export exactly \`${moved}\``);
  const digest = createHash("sha256").update(MOCK.replace(moved, original)).digest("hex");
  assert.equal(
    digest,
    "1d0e828f7344919844ab2baefdbf44ce24c478a3e3b4f2eeb4e6e19791098798",
    "ChangesMock is no longer master's page body modulo the export line (D438)",
  );
});

test("the live changes graph never reaches back into the mock product (D431/D391)", () => {
  const pageSpecs = resolvedImports(PAGE, path.join(HERE, "page.tsx"));
  // The page imports ChangesMock BY DESIGN (it renders the mock branch); what
  // it must never do is read a mock DATA module.
  assert.equal(
    pageSpecs.some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "page.tsx must not import any mock data module",
  );
  const liveSpecs = resolvedImports(LIVE, componentPath("ChangesLive"));
  assert.equal(
    liveSpecs.some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "ChangesLive must not import any mock module",
  );
  // Reads are the page's (D441): the live component receives rows, it queries
  // nothing.
  assert.equal(
    liveSpecs.some((spec) => spec.endsWith("/server/changes")),
    false,
    "ChangesLive must not read the store directly — the page hands it rows",
  );
  assert.ok(!LIVE.includes('"use client"'), "ChangesLive is a server component: nothing on it is interactive in v1");
});

test("the fenced-out mock story is absent from the live surface, not staged (D13, packet §0)", () => {
  const live = code(LIVE);
  assert.doesNotMatch(live, /INC-42/, "the incident badge is S7.4's, derived from real incident windows");
  assert.doesNotMatch(live, /incident/i, "no incident flag is rendered from a client-supplied boolean");
  // An EVENT's link points OUT to the source system (D499): an external
  // anchor with the rel, never a product-internal Link.
  assert.match(live, /<a\s+href=\{e\.link\.href\}/, "an event's link renders as an external anchor");
  assert.doesNotMatch(live, /<Link\s+href=\{e\.link/, "an event's link must never be a product-internal Link");
  assert.match(live, /rel="noopener noreferrer"/, "external links carry the D499 rel");
  assert.match(live, /target="_blank"/);
  // The honest empty state points at the recipe, inside the product.
  assert.match(
    live,
    /<Link\s+href="\/app\/docs\/connectors\/github-actions"/,
    "the empty state must link the recipe page",
  );
});
