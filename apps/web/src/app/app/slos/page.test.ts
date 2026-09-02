import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// S7.3 T5's guards for /app/slos, read from SOURCE (the alerts/changes
// `page.test.ts` precedent, D431/D438): the mock branch pays nothing and
// renders master's page body byte for byte; the live graph never reaches back
// into the mock product; the fenced-out mock story (the analyst's note, the
// IaC export, a status-page link) is ABSENT from the live surface (D13, packet
// §0/D514); the flip itself is asserted at the registry (`live-routes.test.ts`).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");

const PAGE = read("page.tsx");

const componentPath = (name: string) => path.join(HERE, `../../../components/slos/${name}.tsx`);
const component = (name: string) => readFileSync(componentPath(name), "utf8");
const MOCK = component("SlosMock");
const LIVE = component("SlosLive");
const EDITOR = component("SlosEditor");

/** Comments stripped, so a claim below is a claim about the CODE. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

test("the mock branch returns before the first await (D431)", () => {
  assert.match(PAGE, /if \(dataMode !== "live"\) return <SlosMock \/>;/, "the mock branch must return SlosMock with no props, and nothing else");
  const body = code(PAGE);
  const branch = body.indexOf('if (dataMode !== "live")');
  const firstAwait = body.indexOf("await ");
  assert.ok(branch >= 0, "page.tsx must branch on dataMode");
  assert.ok(firstAwait >= 0, "page.tsx has no live-only await — the guard would pass vacuously");
  assert.ok(firstAwait > branch, "page.tsx runs an await before its mock branch");
});

test("SlosMock is master's page body, byte for byte, modulo the export line (D438/D514)", () => {
  // Regenerate the pin with:
  //   git show master:apps/web/src/app/app/slos/page.tsx | shasum -a 256
  const moved = "export function SlosMock() {";
  const original = "export default function SlosPage() {";
  assert.ok(!MOCK.includes('"use client"'), "SlosMock must stay the server body it was");
  assert.ok(MOCK.includes(moved), `SlosMock must export exactly \`${moved}\``);
  const digest = createHash("sha256").update(MOCK.replace(moved, original)).digest("hex");
  assert.equal(digest, "209e838832581fcb44cdb518969bbc6fe425eb692efd1709c22790f17f263b9c", "SlosMock is no longer master's page body modulo the export line (D438)");
});

test("the live slos graph never reaches back into the mock product (D431/D391)", () => {
  const files = [
    ["page.tsx", PAGE, path.join(HERE, "page.tsx")],
    ["SlosLive.tsx", LIVE, componentPath("SlosLive")],
    ["SlosEditor.tsx", EDITOR, componentPath("SlosEditor")],
  ] as const;
  for (const [what, source, filePath] of files) {
    const specifiers = resolvedImports(source, filePath);
    assert.equal(specifiers.some((spec) => /(^|\/)mock\//.test(spec)), false, `${what} must not import any mock data module`);
    if (what === "page.tsx") continue;
    // TerraformExport narrates the fixture objectives; the live surface has no
    // evaluated counterpart for it, so it is absent (D13), not carried.
    assert.equal(specifiers.some((spec) => spec.endsWith("/TerraformExport")), false, `${what} must not import TerraformExport (D13)`);
  }
});

test("SlosLive is a server component fed resolved rows; SlosEditor owns the client half", () => {
  assert.ok(!LIVE.includes('"use client"'), "SlosLive must stay a server component (D428)");
  assert.ok(EDITOR.startsWith('"use client";'), "SlosEditor is the client half");
  const liveSpecs = resolvedImports(LIVE, componentPath("SlosLive"));
  assert.equal(liveSpecs.some((spec) => spec.endsWith("/server/slos")), false, "SlosLive must not read the store directly — the page hands it rows");
  assert.equal(liveSpecs.some((spec) => spec.endsWith("/server/usage")), false, "SlosLive must not read the plan — the page hands it retentionDays");
});

test("the fenced-out mock story is absent from the live surface, not staged (D13, packet §0)", () => {
  const live = code(LIVE);
  for (const fact of ["31%", "afternoon", "kb-reindex", "Meridian"]) {
    assert.equal(live.includes(fact), false, `SlosLive narrates "${fact}" — a fact about the fixture, not about a live workspace`);
  }
  assert.equal(live.includes('"/status"'), false, "the live surface links the public status page (D256/D324)");
  // The four-way status vocabulary is rendered, no-data included (D508).
  for (const status of ["healthy", "at-risk", "breached", "no-data"]) {
    assert.ok(live.includes(`"${status}"`) || live.includes(`${status}:`), `SlosLive has no style for the ${status} status`);
  }
  // The inspect link is BUILT from the traces filter vocabulary, never typed.
  assert.match(live, /tracesHref\(/, "the inspect link must be built with tracesHref");
  assert.doesNotMatch(live, /"\/app\/traces\?/, "a hand-typed traces query string would drift from parseTracesUrl");
  // The objective sentence comes from the ONE formatter.
  assert.match(live, /formatSloObjective\(/);
  // The tour's anchor survives the flip in BOTH components (D515).
  assert.ok(LIVE.includes('data-tour="slos"'), 'SlosLive dropped data-tour="slos"');
  assert.ok(MOCK.includes('data-tour="slos"'), 'SlosMock dropped data-tour="slos"');
});
