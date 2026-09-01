import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// The D401 guard for both services routes, as a SOURCE-TEXT test (D391a): the
// rule is what these four files SAY, never what their transitive import graph
// resolves to — `@/server/data` statically imports `@/mock/*` for its own mock
// branch, so a graph-level claim is not one anybody can make. Source is also
// the only option available: importing the real modules here would pull
// `next/link` and `lucide-react` into a `--conditions react-server` process,
// where React exports no `createContext` (explore/page.test.ts, D54(iii)).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const resolve = (file: string) => path.join(HERE, file);
const read = (file: string) => readFileSync(resolve(file), "utf8");

/**
 * Comments stripped, so every claim below is a claim about the CODE. All six
 * files explain themselves in prose that quotes the very things this test
 * forbids — the mock module path, the word `await`, the `"use client"`
 * directive — and a rule read off the raw text would be a rule against
 * documenting the rule.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const LIST_PAGE_PATH = resolve("page.tsx");
const DETAIL_PAGE_PATH = resolve("[id]/page.tsx");
const LIST_LIVE_PATH = resolve("../../../components/services/ServicesLive.tsx");
const DETAIL_LIVE_PATH = resolve("../../../components/services/ServiceDetailLive.tsx");
const LIST_PAGE = code(read("page.tsx"));
const DETAIL_PAGE = code(read("[id]/page.tsx"));
const LIST_MOCK = code(read("../../../components/services/ServicesMock.tsx"));
const DETAIL_MOCK = code(read("../../../components/services/ServiceDetailMock.tsx"));
const LIST_LIVE = code(read("../../../components/services/ServicesLive.tsx"));
const DETAIL_LIVE = code(read("../../../components/services/ServiceDetailLive.tsx"));

function assertMockBranchFirst(label: string, body: string): void {
  const branch = body.indexOf('if (dataMode !== "live")');
  const firstAwait = body.indexOf("await ");
  assert.ok(branch >= 0, `${label} has no dataMode branch`);
  assert.ok(firstAwait >= 0, `${label} has no live-only await — the guard would pass vacuously`);
  assert.ok(
    branch < firstAwait,
    `${label} must return its mock component before the first await, so the mock render stays static`,
  );
}

test("both pages branch on dataMode and return the moved mock body first, with today's props", () => {
  assert.match(
    LIST_PAGE,
    /if \(dataMode !== "live"\) return <ServicesMock \/>;/,
    "the catalog's mock branch must return ServicesMock with no props, and nothing else",
  );
  assert.match(
    DETAIL_PAGE,
    /if \(dataMode !== "live"\) return <ServiceDetailMock params=\{params\} \/>;/,
    "the detail's mock branch must hand the moved body the params PROMISE — awaiting it here would move the await ahead of the branch",
  );
  assertMockBranchFirst("services/page.tsx", LIST_PAGE);
  assertMockBranchFirst("services/[id]/page.tsx", DETAIL_PAGE);
});

test("D401: the detail page's ONE mock import is the deploys fixture, and the catalog fixture stays in the mock branch", () => {
  // Every ban below reads what an import RESOLVES to, never the alias
  // someone happened to type (`resolvedImports`, D448).
  assert.equal(
    resolvedImports(LIST_PAGE, LIST_PAGE_PATH).some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "the catalog page reads no fixture at all — ServicesMock owns that import",
  );
  const detailMockSpecs = resolvedImports(DETAIL_PAGE, DETAIL_PAGE_PATH).filter((spec) =>
    /(^|\/)mock\//.test(spec),
  );
  assert.equal(
    detailMockSpecs.length,
    1,
    `services/[id]/page.tsx must name exactly one mock module, found ${detailMockSpecs.length}`,
  );
  // The catalog fixture is the mock branch's alone (a live page reaching for
  // it would be the fabricated service list this whole task exists to
  // replace) — asserted by naming the ONE mock module allowed, not by
  // excluding catalog's alias spelling.
  assert.equal(
    detailMockSpecs[0],
    "@/mock/intelligence",
    "the one mock import must be the deploys fixture D362/D401 keeps rendering",
  );
  assert.ok(
    DETAIL_PAGE.includes('import { deploys } from "@/mock/intelligence";'),
    "the one mock import must be the deploys fixture D362/D401 keeps rendering",
  );
  assert.ok(LIST_MOCK.includes('from "@/mock/catalog"'));
  assert.ok(DETAIL_MOCK.includes('from "@/mock/catalog"'));
});

test("A2/D392: neither Live component imports mock data or ships client JS", () => {
  for (const [label, src, filePath] of [
    ["ServicesLive.tsx", LIST_LIVE, LIST_LIVE_PATH],
    ["ServiceDetailLive.tsx", DETAIL_LIVE, DETAIL_LIVE_PATH],
  ] as const) {
    assert.equal(
      resolvedImports(src, filePath).some((spec) => /(^|\/)mock\//.test(spec)),
      false,
      `${label} must not depend on any mock module`,
    );
    assert.equal(
      src.includes('"use client"'),
      false,
      `${label} is a server component (D392) — selection here is a <Link>, so there is no interactivity to ship JS for`,
    );
  }
  // The deploys panel renders in live mode (D362), which only stays honest
  // while it is marked as sample content.
  assert.ok(
    DETAIL_LIVE.includes(
      '<SampleMark title="sample data — deploy tracking arrives with the changes feed (M6)" />',
    ),
    "the live deploys panel must carry its SampleMark verbatim",
  );
});

test("the mock bodies are the untouched page bodies, moved", () => {
  assert.match(LIST_MOCK, /export function ServicesMock\(\)\s*\{/, "ServicesMock must take no props");
  assert.match(
    DETAIL_MOCK,
    /export async function ServiceDetailMock\(\{\n\s*params,\n\}: \{\n\s*params: Promise<\{ id: string \}>;\n\}\)/,
    "ServiceDetailMock must keep the page signature it was moved from",
  );
  // Pinned markers from the two original bodies (96 + 172 lines): if any of
  // these move or vanish, the verbatim move this test exists to catch has
  // drifted — every one of them names a fixture-only field D397 removed from
  // the live surfaces, so they can only live here.
  for (const marker of ['grade(s) === "A"', "sloStyle[s.sloStatus]", "{s.deps.length}", "T{s.tier}"]) {
    assert.ok(LIST_MOCK.includes(marker), `ServicesMock lost "${marker}"`);
  }
  for (const marker of [
    'from "@/mock/intelligence"',
    "const scoreRows = [",
    "deploys.slice(0, 3)",
    "service.deps.map((dep)",
    "{passing}/4 checks passing",
  ]) {
    assert.ok(DETAIL_MOCK.includes(marker), `ServiceDetailMock lost "${marker}"`);
  }
});
