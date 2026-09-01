import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// S7.1 T6's guards for /app/alerts, read from SOURCE (the dashboards
// `page.test.ts` precedent): the mock branch pays nothing and renders
// master's page body byte for byte; the live graph never reaches back into
// the mock product; the flip itself is asserted at the registry
// (`live-routes.test.ts`), not here (S2.0 L1).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");

const PAGE = read("page.tsx");

const componentPath = (name: string) =>
  path.join(HERE, `../../../components/alerts/${name}.tsx`);
const component = (name: string) => readFileSync(componentPath(name), "utf8");
const MOCK = component("AlertsMock");
const LIVE = component("AlertsLive");
const EDITOR = component("AlertsEditor");

test("the mock branch returns before the first await (D431)", () => {
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <AlertsMock \/>;/,
    "the mock branch must return AlertsMock with no props, and nothing else",
  );
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const branch = code.indexOf('if (dataMode !== "live")');
  const firstAwait = code.indexOf("await ");
  assert.ok(branch >= 0, "page.tsx must branch on dataMode");
  assert.ok(
    firstAwait > branch,
    "page.tsx runs an await before its mock branch — mock mode would pay for a live-only read",
  );
});

test("AlertsMock is master's page body, byte for byte, modulo the export line (D438)", () => {
  // The pin is the sha256 of the file as `master` holds it. Regenerate with:
  //   git show master:apps/web/src/app/app/alerts/page.tsx | shasum -a 256
  // Diff a failure:
  //   diff <(git show master:apps/web/src/app/app/alerts/page.tsx) \
  //        src/components/alerts/AlertsMock.tsx
  const moved = "export function AlertsMock() {";
  const original = "export default function AlertsPage() {";

  // Master's alerts page was a SERVER component (no "use client") — the moved
  // body must stay one, or the mock DOM's hydration story changes shape.
  assert.ok(!MOCK.includes('"use client"'), "AlertsMock must stay the server body it was");
  assert.ok(MOCK.includes(moved), `AlertsMock must export exactly \`${moved}\``);
  const digest = createHash("sha256").update(MOCK.replace(moved, original)).digest("hex");
  assert.equal(
    digest,
    "f4dc14c94a6fbd249fbe6d59ecc7ab62635f2a6410fb78d71d4a74eeb5ce029e",
    "AlertsMock is no longer master's page body modulo the export line (D438)",
  );
});

test("the live alerts graph never reaches back into the mock product (D431/D391)", () => {
  const files = [
    ["page.tsx", PAGE, path.join(HERE, "page.tsx")],
    ["AlertsLive.tsx", LIVE, componentPath("AlertsLive")],
    ["AlertsEditor.tsx", EDITOR, componentPath("AlertsEditor")],
  ] as const;

  for (const [what, source, filePath] of files) {
    // Resolved specifiers, never typed aliases (D448/S6.3-L1).
    const specifiers = resolvedImports(source, filePath);
    if (what === "page.tsx") {
      // The page imports AlertsMock BY DESIGN (it renders the mock branch);
      // what it must never do is read a mock DATA module.
      assert.equal(
        specifiers.some((spec) => /(^|\/)mock\//.test(spec)),
        false,
        "page.tsx must not import any mock data module",
      );
      continue;
    }
    assert.equal(
      specifiers.some((spec) => /(^|\/)mock\//.test(spec)),
      false,
      `${what} must not import any mock module`,
    );
    // TerraformExport renders demo-only IaC copy for the fixture rules; the
    // live surface has no evaluated counterpart for it, so it is absent
    // (D13), not carried.
    assert.equal(
      specifiers.some((spec) => spec.endsWith("/TerraformExport")),
      false,
      `${what} must not import TerraformExport — it narrates the fixture rules (D13)`,
    );
  }
});

test("AlertsLive is a server component fed resolved rows; AlertsEditor owns the client half", () => {
  assert.ok(!LIVE.includes('"use client"'), "AlertsLive must stay a server component (D428)");
  assert.ok(EDITOR.startsWith('"use client";'), "AlertsEditor is the client half");
  // Reads are the page's (D441): the live component receives rows, it queries
  // nothing — and the editor mutates only through the actions file.
  const liveSpecs = resolvedImports(LIVE, componentPath("AlertsLive"));
  assert.equal(
    liveSpecs.some((spec) => spec.endsWith("/server/alerts")),
    false,
    "AlertsLive must not read the store directly — the page hands it rows",
  );
});
