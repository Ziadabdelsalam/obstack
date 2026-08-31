import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// D367's byte-identity claim ("rendered DOM byte-identical in mock mode")
// rests on two facts: `explore/page.tsx`'s mock branch hands `ExploreMock`
// ZERO props, and `ExploreMock.tsx` is the untouched 199-line client body,
// moved verbatim. Neither can be proven by IMPORTING the real modules here:
// `ExploreMock`/`ExploreLive` are `"use client"` and both pull `recharts` in
// (through `ExploreChart` and their own chart respectively), and recharts
// extends a React class this react-server build does not export
// (`Class extends value undefined is not a constructor` — measured, worse
// than the `next/link`/`lucide-react` poison `mock-mode.test.ts`'s
// `createContext` shim patches around, and not something a shim fixes). So
// this reads source instead, the `shell-honesty.test.ts`/
// `ConnectionsHub.test.tsx` fallback for exactly this situation (D54(iii):
// no DOM harness in this repo, and here, no import path either).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");
const PAGE = read("page.tsx");
const MOCK = read("../../../components/explore/ExploreMock.tsx");
const LIVE = read("../../../components/explore/ExploreLive.tsx");

test("the mock branch renders ExploreMock, verbatim and with zero props, before any live-only read runs", () => {
  assert.ok(
    PAGE.includes('import { ExploreMock } from "@/components/explore/ExploreMock";'),
    "page.tsx must import the moved mock component",
  );
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <ExploreMock \/>;/,
    "the mock branch must return ExploreMock with no props, and nothing else",
  );
  const mockBranch = PAGE.indexOf('if (dataMode !== "live")');
  const liveOnlyRead = PAGE.indexOf("await connection()");
  assert.ok(
    mockBranch >= 0 && liveOnlyRead > mockBranch,
    "the mock branch must return before the live-only session/connection reads run",
  );
});

test("ExploreMock is the untouched client body — it takes no props and owns its own state", () => {
  assert.ok(MOCK.startsWith('"use client";'), "ExploreMock must stay a client component");
  assert.match(MOCK, /export function ExploreMock\(\)\s*\{/, "ExploreMock must take no props");
  // Pinned markers from the original 199-line explore/page.tsx body (S6.1
  // T7/D367): if any of these move or vanish, the "verbatim move" this test
  // exists to catch has drifted.
  for (const marker of [
    'from "@/mock/explore"',
    "GROUP_OPTIONS",
    "RANGE_OPTIONS",
    "CHART_OPTIONS",
    "Save to dashboard",
    "SaveToDashboardModal",
    "<ExploreChart query={query} chartType={chartType} />",
  ]) {
    assert.ok(MOCK.includes(marker), `ExploreMock lost "${marker}" — the moved body drifted from the original page`);
  }
});

test("A2: the live branch never imports mock data, and never renders Save-to-dashboard (D367/D13)", () => {
  assert.equal(
    LIVE.includes('from "@/mock/explore"') || LIVE.includes('from "@/mock/'),
    false,
    "the live chart must not depend on any mock module",
  );
  // The two INDIRECT routes back into the mock product, both named by D367:
  // `ExploreChart` calls `exploreSeries()` internally (so importing it drags
  // `@/mock/explore` into the live graph without ever naming it), and
  // `state/workspace-store` is the mock workspace `SaveToDashboardModal`
  // reads. Neither shows up in the `@/mock/` check above.
  assert.equal(
    /from "@\/components\/explore\/ExploreChart"/.test(LIVE),
    false,
    "the live chart is a props-fed sibling (D367) — reusing ExploreChart drags @/mock/explore in through its own exploreSeries() call",
  );
  assert.equal(
    /from "@\/state\/workspace-store"/.test(LIVE),
    false,
    "live filters live in the URL, never in the mock workspace store",
  );
  assert.equal(
    /import.*SaveToDashboardModal/.test(LIVE),
    false,
    "save-to-dashboard is an honest absence in live mode (D367/D13), not a hidden import",
  );
});
