import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// The D367/D400 shape of `/app/traces/diff`, and the D406 half of it that edits
// a surface live in production today: the trace-detail compare link. Both are
// source-text tests for `explore/page.test.ts`'s reason — `TraceDiffMock` and
// `TraceExplorer` are `"use client"` and pull `next/link`/`lucide-react` in,
// which call `createContext` at module scope, and this runner's react-server
// React does not have it. The seeded half (real traces through the facade into
// `TraceDiffLive`) lives in `page.integration.test.ts` next door, which shims
// that one function per D156 and can therefore import the component.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const resolve = (file: string) => path.join(HERE, file);
const read = (file: string) => readFileSync(resolve(file), "utf8");
// Comments state what moved and why, so a scan for a moved thing has to read
// the code without them (the `ExplainPanel.test.tsx` treatment).
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// Every assertion below reads the STRIPPED text: each of these files explains
// in prose what it must not contain, and a scan that counted those sentences
// would pass on a file that had re-imported the thing they name.
const LIVE_PATH = resolve("../../../../components/trace/TraceDiffLive.tsx");
const EXPLORER_PATH = resolve("../../../../components/trace/TraceExplorer.tsx");
const PAGE = strip(read("page.tsx"));
const MOCK_RAW = read("../../../../components/trace/TraceDiffMock.tsx");
const MOCK = strip(MOCK_RAW);
const LIVE = strip(read("../../../../components/trace/TraceDiffLive.tsx"));
const EXPLORER = strip(read("../../../../components/trace/TraceExplorer.tsx"));
const DETAIL = strip(read("../[id]/page.tsx"));

test("the mock branch renders TraceDiffMock, with zero props, before anything request-shaped is awaited", () => {
  assert.ok(
    PAGE.includes('import { TraceDiffMock } from "@/components/trace/TraceDiffMock";'),
    "page.tsx must import the moved mock component",
  );
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\)\s*return \(\s*<Suspense>\s*<TraceDiffMock \/>\s*<\/Suspense>\s*\);/,
    "the mock branch must return <Suspense><TraceDiffMock /></Suspense> with no props, and nothing else",
  );
  const code = PAGE;
  const mockBranch = code.indexOf('if (dataMode !== "live")');
  const firstAwait = code.indexOf("await ");
  assert.ok(mockBranch >= 0, "no dataMode branch in the diff page");
  assert.ok(
    firstAwait > mockBranch,
    "the mock branch must return before the first await — searchParams and the facade reads are live-only",
  );
});

test("TraceDiffMock is the untouched client body — no props, its own state, its own mock reads", () => {
  assert.ok(MOCK_RAW.startsWith('"use client";'), "TraceDiffMock must stay a client component");
  assert.match(MOCK, /export function TraceDiffMock\(\)\s*\{/, "TraceDiffMock must take no props");
  // Pinned markers from the original 188-line TraceDiff.tsx (S6.2 T5/D400): if
  // any of these move or vanish, the "verbatim move" this test exists to catch
  // has drifted.
  for (const marker of [
    'import { allTraces, getTrace } from "@/mock/traces";',
    'import { slowTrace } from "@/mock/stories";',
    "const params = useSearchParams();",
    "const [aId, setAId] = useState(params.get(\"a\") ?? slowTrace.id);",
    "aria-label={`Trace ${side}`}",
    "allTraces.slice(0, 30)",
    "spans matched by name; repeated spans (retries) are summed",
  ]) {
    assert.ok(MOCK.includes(marker), `TraceDiffMock lost "${marker}" — the moved body drifted from the original`);
  }
});

test("A2/D392: the live diff is a server component that reads no mock module", () => {
  // Ban reads what the import RESOLVES to, never the alias someone happened
  // to type (`resolvedImports`, D448). `strip()` only removes comments, so
  // the specifiers below are read from the same code the earlier checks used.
  assert.equal(
    resolvedImports(LIVE, LIVE_PATH).some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "the live diff must not depend on any mock module",
  );
  assert.equal(LIVE.includes('"use client"'), false, "D392: the live diff is a server component — selection is a URL");
  assert.equal(
    /useState|useMemo|useSearchParams|onChange=/.test(LIVE),
    false,
    "D392: no client state and no <select> — the picker is <Link>s",
  );
  // D391: the fold rule is DUPLICATED here rather than shared with the frozen
  // mock body, so both files must own one.
  assert.match(LIVE, /function rowsFor\(a: Trace, b: Trace\): DiffRow\[\]/);
  assert.match(MOCK, /function rowsFor\(a: Trace, b: Trace\): DiffRow\[\]/);
  // The two D400 states, verbatim.
  assert.ok(LIVE.includes("pick a second trace"), "the missing-b state must say what to do");
  assert.ok(
    LIVE.includes("trace not found in this workspace"),
    "an unknown or foreign id must say so — the scoped read (D113) cannot see another workspace's trace",
  );
});

test("the live branch resolves both sides in parallel through the facade, and the picker from one read", () => {
  const code = PAGE;
  assert.match(code, /await Promise\.all\(\[/, "the two sides and the picker are three independent reads");
  assert.match(code, /aId \? data\.getTrace\(aId\) : undefined/);
  assert.match(code, /bId \? data\.getTrace\(bId\) : undefined/);
  assert.match(code, /data\.searchTraces\(\{\}\)/);
  assert.match(code, /search\.traces\.slice\(0, DIFF_PICKER_SIZE\)/, "the picker is capped by the one constant");
  assert.match(
    code,
    /a=\{aId \? aTrace \?\? null : recent\[0\] \?\? null\}/,
    "an absent ?a= is 'nothing picked yet' (defaults to the most recent trace), never a 'not found'",
  );
  assert.match(code, /b=\{bId \? bTrace \?\? null : null\}/);
});

test("D416: the page tells TraceDiffLive whether A was auto-picked, and slot A knows how to caption it", () => {
  assert.match(
    PAGE,
    /const aAutoPicked = !aId;/,
    "aAutoPicked must read the ABSENCE of ?a= — never whether the resolved A happens to be recent[0], which would caption an explicitly named most-recent id",
  );
  assert.match(
    PAGE,
    /aAutoPicked=\{aAutoPicked\}/,
    "the page must pass whether A was auto-picked (an absent ?a=) to TraceDiffLive",
  );
  assert.ok(
    LIVE.includes("most recent trace — pick another to compare"),
    "D416: slot A must carry this exact caption when it was auto-picked",
  );
  // The seeded test next door proves WHEN the caption prop is handed over; only
  // the text can show that the slot renders what it was handed.
  assert.match(
    LIVE,
    /\{caption && </,
    "TraceSummary must render the caption it is given, not just accept it",
  );
});

test("D400: the compare entry point is an href from the page — the mock corpus is out of the client bundle", () => {
  assert.equal(
    resolvedImports(EXPLORER, EXPLORER_PATH).some((spec) => /(^|\/)mock\//.test(spec)),
    false,
    "TraceExplorer is a client component: importing the mock corpus ships it to every live trace page",
  );
  assert.equal(EXPLORER.includes("compareEnabled"), false, "the boolean flag is replaced, not kept beside the href");
  assert.match(EXPLORER, /compare: \{ href: string \} \| null;/, "the prop is the resolved link, nullable");
  assert.match(
    EXPLORER,
    /\{compare && \(\s*<Link\s+href=\{compare\.href\}/,
    "the link renders exactly when the page resolved one",
  );
  // Byte-identity aid: the rendered link itself is untouched.
  assert.ok(EXPLORER.includes("diff vs healthy run"));
});

test("D400: trace detail computes `compare` per mode, and the mock href is the one it always was", () => {
  const code = DETAIL;
  assert.match(code, /import \{ allTraces \} from "@\/mock\/traces";/, "the partner lookup moved to the page (D391(b))");
  assert.match(
    code,
    /if \(dataMode === "live"\) return \{ href: `\/app\/traces\/diff\?a=\$\{trace\.id\}` \};/,
    "live links to the diff with this trace as side A and no partner",
  );
  // The mock branch, character for character what TraceExplorer used to
  // compute — same predicate, same href, therefore the same DOM.
  assert.match(
    code,
    /allTraces\.find\(\s*\(t\) => t\.rootName === trace\.rootName && t\.status === "ok" && t\.id !== trace\.id,\s*\)/,
  );
  assert.match(code, /partner \? \{ href: `\/app\/traces\/diff\?a=\$\{trace\.id\}&b=\$\{partner\.id\}` \} : null/);
  assert.match(code, /compare=\{compareLink\(trace\)\}/);
});
