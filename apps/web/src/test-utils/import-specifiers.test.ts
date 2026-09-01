import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "./import-specifiers";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // apps/web/src/test-utils
// A stand-in file path for resolution — this file need not exist; only its
// directory (a components subfolder two levels under `src`) matters for the
// relative cases below.
const DASHBOARDS_LIVE_PATH = path.join(HERE, "../components/dashboards/DashboardsLive.tsx");

test("a bare package specifier passes through unchanged", () => {
  assert.deepEqual(
    resolvedImports('import { useState } from "react";', DASHBOARDS_LIVE_PATH),
    ["react"],
  );
});

test("an alias specifier passes through unchanged", () => {
  assert.deepEqual(
    resolvedImports('import type { Dashboard } from "@/lib/dashboard-types";', DASHBOARDS_LIVE_PATH),
    ["@/lib/dashboard-types"],
  );
});

test("a same-folder relative specifier resolves to the @/ form (D448)", () => {
  assert.deepEqual(
    resolvedImports('import { WidgetLive } from "./WidgetLive";', DASHBOARDS_LIVE_PATH),
    ["@/components/dashboards/WidgetLive"],
  );
});

test("a ../../ relative specifier resolves to the SAME string as its @/ spelling — the evasion this guard closes (D448)", () => {
  const relative = resolvedImports('import { dashboards } from "../../mock/dashboards";', DASHBOARDS_LIVE_PATH);
  const aliased = resolvedImports('import { dashboards } from "@/mock/dashboards";', DASHBOARDS_LIVE_PATH);
  assert.deepEqual(relative, ["@/mock/dashboards"]);
  assert.deepEqual(relative, aliased);
});

test("a SIDE-EFFECT import names a module with no `from` — and is still a ban-able specifier (D448)", () => {
  // `services/page.test.ts`'s pre-D448 `src.includes("@/mock/")` caught this
  // form; a resolver that only looked for `from` would have let it through.
  assert.deepEqual(resolvedImports('import "@/mock/catalog";', DASHBOARDS_LIVE_PATH), [
    "@/mock/catalog",
  ]);
  assert.deepEqual(resolvedImports('import "../../mock/catalog";', DASHBOARDS_LIVE_PATH), [
    "@/mock/catalog",
  ]);
});

test("`export … from` re-exports are specifiers too", () => {
  assert.deepEqual(resolvedImports('export * from "../../mock/dashboards";', DASHBOARDS_LIVE_PATH), [
    "@/mock/dashboards",
  ]);
});

test("a dynamic import() specifier is resolved exactly like a static one", () => {
  assert.deepEqual(
    resolvedImports('const m = await import("../../mock/dashboards");', DASHBOARDS_LIVE_PATH),
    ["@/mock/dashboards"],
  );
});

test("every specifier in a multi-import source is returned, in order", () => {
  const source = [
    'import { useState } from "react";',
    'import type { Dashboard } from "@/lib/dashboard-types";',
    'import { WidgetLive } from "./WidgetLive";',
  ].join("\n");
  assert.deepEqual(resolvedImports(source, DASHBOARDS_LIVE_PATH), [
    "react",
    "@/lib/dashboard-types",
    "@/components/dashboards/WidgetLive",
  ]);
});
