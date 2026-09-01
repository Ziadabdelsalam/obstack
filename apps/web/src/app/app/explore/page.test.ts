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
const SAVE_LIVE = read("../../../components/explore/SaveToDashboardLive.tsx");

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

test("A2: the live branch never imports mock data, and saves through SaveToDashboardLive, never the mock modal (D433)", () => {
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
    "the mock modal reads the mock workspace store — live saves through SaveToDashboardLive instead (D433)",
  );
  // REQUIRED, not banned (D433): save-to-dashboard is no longer an honest
  // absence — this is the sabotage check. Deleting the import from
  // ExploreLive.tsx must turn this assertion red.
  assert.ok(
    /from "@\/components\/explore\/SaveToDashboardLive"/.test(LIVE),
    "the live save-to-dashboard button must be wired through SaveToDashboardLive (D433)",
  );
});

test("SaveToDashboardLive stays on the live side of the mock/live boundary (D391/D433)", () => {
  assert.equal(
    SAVE_LIVE.includes('from "@/mock/explore"') || SAVE_LIVE.includes('from "@/mock/'),
    false,
    "the live save modal must not depend on any mock module",
  );
  assert.equal(
    /from "@\/components\/explore\/ExploreChart"/.test(SAVE_LIVE),
    false,
    "the live save modal has no chart to render",
  );
  assert.equal(
    /from "@\/state\/workspace-store"/.test(SAVE_LIVE),
    false,
    "the live save modal lists the dashboards prop, never the mock workspace store",
  );
  assert.equal(
    /import.*SaveToDashboardModal/.test(SAVE_LIVE),
    false,
    "markup is copied from SaveToDashboardModal (D391), never imported",
  );
});

test("the saved widget is D433's mapping — timeseries, unpinned, titled from the query", () => {
  // Source-text, like every other guard here: a client component with a server
  // action cannot be imported under `--conditions react-server`. `kind` and
  // `pinned` are both valid contract values in any shape, so the compiler
  // cannot hold this — only these assertions can.
  assert.ok(
    /kind:\s*"timeseries"/.test(SAVE_LIVE),
    "explore saves bars over TIME, so the kind is always timeseries (D433)",
  );
  assert.equal(
    /kind:\s*"(topn|stat|table)"/.test(SAVE_LIVE),
    false,
    "no chart-type state reaches this modal — there is no second kind to save (D433)",
  );
  assert.ok(
    /pinned:\s*false/.test(SAVE_LIVE),
    "pinning is an editor action on the dashboard (D425), never a save-time choice",
  );
  assert.ok(
    SAVE_LIVE.includes("`${query.metric} · ${query.agg}`") &&
      SAVE_LIVE.includes("` by ${query.groupBy}`"),
    "the title is `${metric} · ${agg}` plus ` by ${groupBy}` when grouped (D433)",
  );
});
