import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// run with: npm test --workspace apps/web
//
// The live RCA panel's provable half (S7.4 packet D552/D553/D556/D557). Same
// `require`-seam stubbing as `ExplainPanel.test.tsx`: the panel is `"use
// client"` and imports `next/link` and `lucide-react` at module scope, neither
// of which loads under `--conditions react-server` (D54(ii)).
const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "next/link") return { __esModule: true, default: () => null };
  if (request === "lucide-react") return { __esModule: true, Sparkles: () => null };
  return origLoad.call(this, request, ...rest);
};

const { rcaUrl, usedAfter } = createRequire(fileURLToPath(import.meta.url))(
  "./IncidentRcaPanel.tsx",
) as typeof import("./IncidentRcaPanel");

const here = import.meta.dirname;
const source = (file: string) => readFileSync(path.join(here, file), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const panelSource = source("IncidentRcaPanel.tsx");
const panelCode = strip(panelSource);
const mockSource = source("IncidentRca.tsx");
const mockCode = strip(mockSource);

const explanation = {
  headline: "h",
  failedWhere: "w",
  rootCause: "c",
  evidence: [{ label: "l", detail: "d" }],
  suggestion: "s",
};

test("no fake stream and no motion fork in the live panel — and the mock's typewriter DOES animate (D230/D556)", () => {
  // Both halves in ONE test, so a reviewer cannot satisfy the ban by pointing
  // at the wrong file: the live panel carries none of the fictions, and the
  // fixture typewriter — which animates a story nothing ever streamed, on a
  // page whose bytes are pinned — carries them all. If the mock half ever goes
  // red, the pinned mock body changed, which the S7.4 exit clause forbids.
  const fictions = ["requestAnimationFrame", "cancelAnimationFrame", "prefers-reduced-motion", "performance.now"];
  for (const fiction of fictions) {
    assert.equal(panelCode.includes(fiction), false, `${fiction} is in the live RCA panel`);
  }
  for (const fiction of fictions) {
    assert.ok(mockCode.includes(fiction), `IncidentRca.tsx (the mock typewriter) no longer carries ${fiction}`);
  }
  // The one sentence D230 asks the live panel to carry, in the comments the
  // scan strips.
  assert.match(panelSource, /prefers-reduced-motion/);
  // And the mock typewriter is not on the live panel's import graph.
  assert.doesNotMatch(panelCode, /from\s+["']\.\/IncidentRca["']/);
  assert.doesNotMatch(panelCode, /IncidentRca\b(?!Panel)/);
});

test("no quota literal lives in the panel (D226)", () => {
  assert.equal(/\b(20|200)\b/.test(panelCode), false, "an Explain quota is spelled in TypeScript");
});

test("the panel imports the Explain fold rather than copying it (D552)", () => {
  // One fold for two subjects: the frame reader, the phase machine and the
  // POST all live in `ExplainPanel.tsx`, and this file reaches them by import.
  // A `fetch(` or a `readExplainStream(` here would be a second copy of the
  // fold — the drift the D227 parse cannot survive.
  assert.match(panelCode, /from "@\/components\/trace\/ExplainPanel"/);
  for (const name of ["RUN_START", "TRUNCATED_DETAIL", "UNREACHABLE_DETAIL", "costsARun", "explainCounterLine", "runExplain"]) {
    assert.ok(panelCode.includes(name), `${name} is not imported from the trace panel`);
  }
  assert.equal(panelCode.includes("fetch("), false, "the panel fetches on its own");
  assert.equal(panelCode.includes("readExplainStream"), false, "the panel parses the frame on its own");
  assert.equal(panelCode.includes("applyExplainEvent"), false, "the panel folds the frame on its own");
});

test("a run starts only from the control, never from a render (a page view is not a spend)", () => {
  // `runExplain` is called exactly once in the file, inside `start`, and the
  // one `useEffect` holds nothing but the abort — so mounting the panel cannot
  // POST. The trace panel runs on open because opening it IS the click; an
  // incident page is a page view.
  const calls = panelCode.match(/runExplain\(/g) ?? [];
  assert.equal(calls.length, 1, "runExplain is called more than once");
  const effects = [...panelCode.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\}, \[[^\]]*\]\);/g)];
  assert.equal(effects.length, 1, "the panel gained a second effect — check it does not run");
  assert.equal(effects[0][1].includes("runExplain"), false, "an effect starts a run");
  assert.match(effects[0][1], /abort\(\)/, "the effect is the unmount abort");
  assert.match(panelCode, /onClick=\{start\}/, "the control is what starts the run");
  assert.match(panelCode, /const start = \(\) => \{[\s\S]*?runExplain\(rcaUrl\(incidentId\)/);
});

test("the control is hidden when the timeline holds nothing, and a retained answer never re-runs (D558/D555)", () => {
  // No read row → no control: the route would refuse `no-evidence` for free,
  // but a control that leads to a refusal by construction is not a control.
  assert.match(panelCode, /if \(!canRunRca\) return null;/);
  // `prepared` short-circuits the phase: the answer the page kept is rendered
  // and `start` is never offered, so a reopen spends nothing.
  assert.match(panelCode, /const explanation = prepared \?\? \(run\?\.phase === "answered" \? run\.explanation : null\);/);
  assert.match(panelCode, /if \(!explanation && run === null\)/);
});

test("the two incident references become the two links, and nothing else links (D553)", () => {
  // `eventRef` → an in-page anchor on the timeline row's own id; `traceRef` →
  // the trace route through `<Link>`. A span or log reference is the other
  // subject's and renders as text here — there is no third branch.
  assert.match(panelCode, /href=\{`#\$\{item\.eventRef\}`\}/);
  assert.match(panelCode, /<Link href=\{`\/app\/traces\/\$\{encodeURIComponent\(item\.traceRef\)\}`\}/);
  assert.equal(panelCode.includes("item.spanId"), false);
  assert.equal(panelCode.includes("item.logRef"), false);
});

test("the refusal's own words reach the screen, and the endings are the trace panel's", () => {
  assert.match(panelCode, /run\?\.phase === "refused"\s*\?\s*run\.detail/);
  assert.match(panelCode, /run\?\.phase === "truncated"\s*\?\s*TRUNCATED_DETAIL\s*:\s*UNREACHABLE_DETAIL/);
});

test("the url names a route that exists, and the counter advances by what got past the increment", () => {
  assert.equal(rcaUrl("inc_0123456789abcdef"), "/app/incidents/inc_0123456789abcdef/rca");
  assert.equal(rcaUrl("a/b"), "/app/incidents/a%2Fb/rca", "the id is a path segment, not a path");
  // The route the url points at is on disk — a panel posting to a path nobody
  // serves would report every run as unreachable and spend nothing, quietly.
  assert.ok(
    existsSync(path.resolve(here, "../../app/app/incidents/[id]/rca/route.ts")),
    "the RCA route the panel posts to does not exist",
  );

  assert.equal(usedAfter(4, { phase: "answered", explanation }), 5);
  assert.equal(usedAfter(4, { phase: "truncated" }), 5, "a provider that died mid-run is a counted run");
  assert.equal(usedAfter(4, { phase: "refused", detail: "x" }), 4);
  assert.equal(usedAfter(4, { phase: "unreachable" }), 4);
  assert.equal(usedAfter(4, { phase: "streaming", text: "" }), 4);
});

test("the mock's six RCA headings stay mock-only (D552)", () => {
  // Read from the fixture rather than restated, so a renamed mock heading
  // cannot make this test pass against the wrong six.
  const fixture = readFileSync(path.resolve(here, "../../mock/incident.ts"), "utf8");
  const headings = [...fixture.matchAll(/heading: "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(headings.length, 6, `the fixture carries ${headings.length} RCA headings, not six`);
  for (const heading of headings) {
    assert.equal(panelSource.includes(heading), false, `the live panel renders the mock heading "${heading}"`);
  }
});
