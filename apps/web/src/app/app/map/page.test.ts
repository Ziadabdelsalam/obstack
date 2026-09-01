import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// The `explore/page.test.ts` guard, applied to the map (D367/D391a/D392).
// Source text rather than imports, for the reason that file states: a
// component module cannot be imported under `--conditions react-server`
// without a DOM harness this repo does not have, and `ServiceMapMock` is a
// `"use client"` body pulling `next/navigation` in. What has to be true here is
// textual anyway — that the live file names no mock module, that it is not a
// client component, and that the mock branch returns before any live-only read.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const resolve = (file: string) => path.join(HERE, file);
const read = (file: string) => readFileSync(resolve(file), "utf8");
const PAGE = read("page.tsx");
const MOCK = read("../../../components/map/ServiceMapMock.tsx");
const LIVE_PATH = resolve("../../../components/map/ServiceMapLive.tsx");
const LIVE = read("../../../components/map/ServiceMapLive.tsx");

test("the mock branch renders ServiceMapMock, with zero props, before any live-only read runs", () => {
  assert.ok(
    PAGE.includes('import { ServiceMapMock } from "@/components/map/ServiceMapMock";'),
    "page.tsx must import the moved mock component",
  );
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <ServiceMapMock \/>;/,
    "the mock branch must return ServiceMapMock with no props, and nothing else",
  );
  const mockBranch = PAGE.indexOf('if (dataMode !== "live")');
  const liveOnlyRead = PAGE.indexOf("await connection()");
  assert.ok(
    mockBranch >= 0 && liveOnlyRead > mockBranch,
    "the mock branch must return before the live-only session/connection reads run",
  );
});

test("ServiceMapMock is the untouched demo body — same client component, same fixture, same picture", () => {
  assert.ok(MOCK.startsWith('"use client";'), "ServiceMapMock must stay a client component");
  assert.match(MOCK, /export function ServiceMapMock\(\)\s*\{/, "ServiceMapMock must take no props");
  // Pinned markers from the original 165-line ServiceMap.tsx: the verbatim move
  // (D367) changed the export name and nothing else, so all of these survive.
  for (const marker of [
    'import { useRouter } from "next/navigation";',
    'viewBox="0 0 1000 545"',
    'data-tour="map"',
    "agent-worker",
    "3 pods · 3 restarts 1h",
    "812/min",
    "The red edge is today",
  ]) {
    assert.ok(MOCK.includes(marker), `ServiceMapMock lost "${marker}" — the moved body drifted`);
  }
});

test("A2/D392: the live map imports no mock data and is a server component", () => {
  // Every ban below reads what an import RESOLVES to, never the alias
  // someone happened to type (`resolvedImports`, D448).
  const specs = resolvedImports(LIVE, LIVE_PATH);
  assert.equal(
    specs.some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "the live map must not depend on any mock module",
  );
  // The directive only counts as one when it opens the file, which is exactly
  // what this asserts — the prose below it is free to name it.
  assert.equal(
    /^\s*"use client";/.test(LIVE),
    false,
    "D392: selection is a URL, so the live map ships no client JS at all",
  );
  assert.equal(
    specs.includes("@/components/map/ServiceMapMock"),
    false,
    "the live map is a props-fed sibling (D367), never a reuse of the demo's hardcoded picture",
  );
});

test("D404: the live map carries the tour anchor the guide spotlights", () => {
  assert.ok(LIVE.includes('data-tour="map"'), "TourGuide's /app/map step targets [data-tour=\"map\"]");
});

test("D13: the live map states its window, its cap and what an edge is — in the rendered copy", () => {
  for (const claim of [
    "last {WINDOW_HOURS}h",
    "showing {nodeCap} of {totalServices} services by span volume",
    "error spans ÷ spans",
    "No service has sent a span in the last {WINDOW_HOURS}h.",
  ]) {
    assert.ok(LIVE.includes(claim), `the live map no longer states: ${claim}`);
  }
  // D396's ABSENT list: the demo's pod counts, restarts, externals and its
  // scripted incident are fixture facts, and none of them survives the flip.
  for (const fixtureFact of ["pods", "restarts", "external", "429"]) {
    assert.equal(
      LIVE.includes(fixtureFact),
      false,
      `the live map renders "${fixtureFact}", which is a fact about the demo fixture, not about the workspace`,
    );
  }
});
