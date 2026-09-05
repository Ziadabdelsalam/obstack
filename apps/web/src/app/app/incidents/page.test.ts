import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolvedImports } from "@/test-utils/import-specifiers";

// run with: npm test --workspace apps/web
//
// S7.4 T6's guards for the /app/incidents PAIR — the list at `/app/incidents`
// and the detail at `/app/incidents/[id]` — read from SOURCE (the slos
// `page.test.ts` precedent, D431/D438, widened to two pages): each page's mock
// branch pays nothing; the list's renders master's page body byte for byte
// (D519) and the detail's is a ROUTER over the one fixture (D520); the live
// graph never reaches back into the mock product; the fenced-out mock story
// (the INC-42 fixture, the pipeline/k8s kinds, the six RCA headings, a
// status-page link) is ABSENT from the live surface (D13, D548); the flip
// itself is asserted at the registry (`live-routes.test.ts`), not here
// (S2.0 L1).
//
// The live half of this pair is written in a later phase AGAINST this file, so
// every read is on call, not at load: a file that is not there yet reds its
// own tests with its name, and does not take the D519 pin down with it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../..");
const SELF = fileURLToPath(import.meta.url);

const source = (filePath: string): string => {
  assert.ok(existsSync(filePath), `${path.relative(SRC, filePath)} does not exist yet`);
  return readFileSync(filePath, "utf8");
};
const pagePath = (file: string) => path.join(HERE, file);
const page = (file: string) => source(pagePath(file));
const componentPath = (name: string) => path.join(SRC, `components/incidents/${name}.tsx`);
const component = (name: string) => source(componentPath(name));

/** Comments stripped, so a claim below is a claim about the CODE: the live
 *  files document the very words they must not render. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * The six live files on this surface. Five are components; the sixth,
 * `IncidentRcaPanel`, is T5's and already shipped — it is read here because it
 * renders on the live detail, and a fence that skipped it would leave the one
 * component with a POST in it outside the sweep. `IncidentRcaRail` is the
 * seventh component D546 did not name (D582): the panel needs a CLIENT parent
 * that owns `prepared`/`used` and passes `onFinished`, which a server component
 * cannot, and `IncidentEditor`'s contents are enumerated by D546 (the new
 * button, the controls, the promote picker) — so the RCA's client owner is its
 * own file, fenced exactly as the panel is.
 */
const LIVE_COMPONENTS = [
  "IncidentsLive",
  "IncidentDetailLive",
  "IncidentEditor",
  "IncidentRcaRail",
  "IncidentRcaPanel",
] as const;
const LIVE_PAGES = ["page.tsx", "[id]/page.tsx"] as const;

/**
 * A live component's own source plus the incidents-local modules it imports:
 * a shared pill table is fine; a table borrowed from the mock is not (the
 * mock's tables cannot move without breaking the D519 pin), and neither mock
 * file is ever in a live component's graph (the fence below says so).
 */
function localGraph(name: string): string {
  const own = component(name);
  const locals = resolvedImports(own, componentPath(name))
    .filter((spec) => spec.startsWith("@/components/incidents/") && !/\/Incident(s|Detail)Mock$/.test(spec))
    .map((spec) => {
      const base = path.join(SRC, spec.slice("@/".length));
      const file = [".tsx", ".ts"].map((ext) => base + ext).find((f) => existsSync(f));
      assert.ok(file, `${name} imports ${spec}, which resolves to no file`);
      return readFileSync(file, "utf8");
    });
  return [own, ...locals].join("\n");
}

test("the list page's mock branch returns <IncidentsMock /> before the first await (D431/D519)", () => {
  const PAGE = page("page.tsx");
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <IncidentsMock \/>;/,
    "the mock branch must return IncidentsMock with no props, and nothing else",
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

test("the detail page hands the params PROMISE to the router before its first await, then reads in D539's order (D431/D520/D539)", () => {
  const PAGE = page("[id]/page.tsx");
  assert.match(
    PAGE,
    /if \(dataMode !== "live"\) return <IncidentDetailMock params=\{params\} \/>;/,
    "the mock branch must hand IncidentDetailMock the params promise, unawaited, and nothing else",
  );
  const body = code(PAGE);
  const branch = body.indexOf('if (dataMode !== "live")');
  const firstAwait = body.indexOf("await ");
  assert.ok(branch >= 0, "[id]/page.tsx must branch on dataMode");
  assert.ok(firstAwait >= 0, "[id]/page.tsx has no live-only await — the guard would pass vacuously");
  assert.ok(
    firstAwait > branch,
    "[id]/page.tsx runs an await before its mock branch — `await params` belongs inside the router, after the branch",
  );
  // D539: TWO serialised round trips, because the window is data-dependent —
  // `Promise.all([getIncident, getUsage])` → the D436 sentence on a miss →
  // `await readIncidentTimeline(...)`. A single Promise.all holding the
  // stitcher and the reads that produce its arguments is circular and cannot
  // be written; and the order is the honesty: a bogus id and another tenant's
  // id both issue exactly the getIncident statement and zero telemetry.
  assert.match(
    body,
    /Promise\.all\(\[[^\]]*\bgetIncident\([^\]]*\bgetUsage\(/,
    "the incident row and the plan row are read together, in one Promise.all (D539)",
  );
  const miss = body.indexOf("if (!incident)");
  const stitch = body.indexOf("readIncidentTimeline(");
  assert.ok(miss >= 0, "[id]/page.tsx must branch on the missing incident before it stitches");
  assert.ok(stitch >= 0, "[id]/page.tsx must call readIncidentTimeline — it is the ONLY caller (D539)");
  assert.ok(stitch > miss, "the stitch runs before the not-found branch — a bogus id would issue telemetry reads (D539)");
});

test("IncidentsMock is the pre-flip page body, byte for byte, modulo the export line (D519)", () => {
  // The pin is the sha256 of the file as the PRE-FLIP COMMIT holds it, and the
  // recipe names that commit, not `master`: S7.3's recipe said `master`, and it
  // went stale the day its flip merged — from then on master's page.tsx IS the
  // flipped page, and the recipe regenerates a hash of the wrong file.
  // Regenerate with:
  //   git show 938166c:apps/web/src/app/app/incidents/page.tsx | shasum -a 256
  // Diff a failure:
  //   diff <(git show 938166c:apps/web/src/app/app/incidents/page.tsx) \
  //        src/components/incidents/IncidentsMock.tsx
  // What the pin protects, so nobody "tidies" it: `@/mock/incident` and
  // `IncidentRca` imported, the seven-entry `kindStyle`, the hardcoded
  // `1 in the last 7 days`, the hardcoded `RESOLVED` pill, `data-tour="incident"`
  // at line 27 and the closing capability sentence — the demo's DOM at
  // `/app/incidents`, which D519 keeps byte for byte. A reformat, an import
  // reorder or a lint autofix changes the hash and turns this into a pin of
  // the new body, which proves nothing.
  const MOCK = component("IncidentsMock");
  const moved = "export function IncidentsMock() {";
  const original = "export default function IncidentsPage() {";

  // Master's incidents page was a SERVER component (no "use client") — the
  // moved body must stay one.
  assert.ok(!MOCK.includes('"use client"'), "IncidentsMock must stay the server body it was");
  assert.ok(MOCK.includes(moved), `IncidentsMock must export exactly \`${moved}\``);
  const digest = createHash("sha256").update(MOCK.replace(moved, original)).digest("hex");
  assert.equal(
    digest,
    "0378f02dcbad672286de167fb5e41b51a77a6a8115b691c0f2d4809a244fcdf8",
    "IncidentsMock is no longer the pre-flip page body modulo the export line (D519)",
  );
});

test("IncidentDetailMock is a router over the one fixture, not a screen, and takes no sha pin (D520)", () => {
  // NO SHA PIN, and here is why: master holds ONE incidents body and D519 pins
  // it ONCE, above. This file was invented this sprint, so a digest of it would
  // pin nothing master ever rendered — it would be a hash of itself, proving
  // only that nobody edited it since the hash was typed. The two-digest pin in
  // `dashboards/page.test.ts` works precisely because master held two bodies.
  // What CAN be asserted about a router is that it routes and authors nothing.
  const ROUTER = component("IncidentDetailMock");
  const body = code(ROUTER);
  assert.ok(!ROUTER.includes('"use client"'), "the router stays a server component, like the body it routes to");
  assert.match(
    ROUTER,
    /export async function IncidentDetailMock\(\{\s*params,?\s*\}: \{\s*params: Promise<\{ id: string \}>;?\s*\}\)/,
    "the router takes the params PROMISE (the dashboards/[id]/page.tsx:31 shape)",
  );
  assert.match(body, /await params/, "the router awaits the promise itself — the page hands it through before its own first await (D431)");
  // The fixture's id is read FROM the fixture; a typed "INC-42" would be a
  // second copy of a string the mock owns.
  assert.match(body, /incidents\[0\]\.id/, "the router must compare against incidents[0].id from @/mock/incident");
  assert.doesNotMatch(body, /INC-42/, "the router must not type the fixture's id");
  assert.match(body, /<IncidentsMock \/>/, "the fixture's id renders the pinned body, with no props");
  assert.match(body, /<IncidentNotFound \/>/, "any other id renders the one D436 sentence");
  // It authors no demo DOM: the only JSX it contains is the two components it
  // routes between, and its only imports are those two plus the fixture.
  const tags = [...new Set([...body.matchAll(/<([A-Z][\w.]*)/g)].map((m) => m[1]))].sort();
  assert.deepEqual(tags, ["IncidentNotFound", "IncidentsMock"], "the router renders exactly the two components and nothing of its own");
  assert.doesNotMatch(body, /<[a-z]/, "the router authors no host element — the only net-new mock DOM this sprint is the D436 sentence");
  assert.deepEqual(
    resolvedImports(ROUTER, componentPath("IncidentDetailMock")).sort(),
    ["@/components/incidents/IncidentNotFound", "@/components/incidents/IncidentsMock", "@/mock/incident"],
    "the router imports the two components it routes between and the fixture, nothing else",
  );
});

test("IncidentNotFound is the ONE definition of the D436 sentence, copied from DashboardDetailLive's pair (D436/D440/D546)", () => {
  const NOT_FOUND = component("IncidentNotFound");
  const SENTENCE = "no incident with this id in your workspace";
  assert.ok(!NOT_FOUND.includes('"use client"'), "IncidentNotFound is a server component: it reads nothing and says one thing");
  assert.ok(NOT_FOUND.includes(SENTENCE), "IncidentNotFound must render the D436 sentence");
  assert.ok(NOT_FOUND.includes("← back to incidents"), "IncidentNotFound must offer the way back");
  assert.match(NOT_FOUND, /<Link\s+href="\/app\/incidents"/, "the way back is a product-internal Link to the index");

  // The same words as the store's refusal (D440: an id that never existed and
  // another tenant's get one sentence) — read OUT of the store, never retyped.
  const store = readFileSync(path.join(SRC, "server/incidents.ts"), "utf8");
  const declared = store.match(/const NO_SUCH_INCIDENT = "([^"]+)";/);
  assert.ok(declared, "server/incidents.ts must declare NO_SUCH_INCIDENT as a string literal");
  assert.equal(declared[1], SENTENCE, "the rendered sentence and the store's refusal must be the same words (D440)");

  // The PAIR is DashboardDetailLive's, copied — same sentence frame, same link
  // register — with the noun changed and nothing else.
  const dashboards = readFileSync(path.join(SRC, "components/dashboards/DashboardDetailLive.tsx"), "utf8");
  const frame = (src: string, noun: string) =>
    src.match(new RegExp(`<p className="([^"]+)">no ${noun} with this id in your workspace</p>`))?.[1];
  assert.equal(frame(NOT_FOUND, "incident"), frame(dashboards, "dashboard"), "the sentence's frame is DashboardDetailLive's");
  const linkClass = (src: string) => src.match(/<Link\s+href="\/app\/(?:dashboards|incidents)"\s+className="([^"]+)"/)?.[1];
  assert.ok(linkClass(dashboards), "DashboardDetailLive's back link must still carry a className (the precedent moved)");
  assert.equal(linkClass(NOT_FOUND), linkClass(dashboards), "the back link's register is DashboardDetailLive's");

  // ONE definition: no other file on the surface spells the sentence. A file
  // that does not exist yet defines nothing, so only the files that exist are
  // read here — this is not a skip, it is what "no other definition" means.
  const others = [
    ...LIVE_COMPONENTS.map((name) => [name, componentPath(name)] as const),
    ["IncidentsMock", componentPath("IncidentsMock")] as const,
    ["IncidentDetailMock", componentPath("IncidentDetailMock")] as const,
    ...LIVE_PAGES.map((file) => [file, pagePath(file)] as const),
  ];
  for (const [what, filePath] of others) {
    if (!existsSync(filePath)) continue;
    assert.equal(code(readFileSync(filePath, "utf8")).includes(SENTENCE), false, `${what} spells the D436 sentence — IncidentNotFound is its one definition (D546)`);
  }
});

test("the live incidents graph never reaches back into the mock product (D431/D391/D546)", () => {
  // Every fence compares FULL resolved specifiers (`test-utils/import-specifiers`,
  // D448), and — D542 — none is spelled `endsWith("/incidents")`: `@/lib/docs/incidents`
  // is the public status page's notice loader, which shares the basename and
  // nothing else, so that spelling would ban the wrong module. This file
  // checks itself for it.
  assert.doesNotMatch(
    code(readFileSync(SELF, "utf8")),
    /endsWith\(["']\/incidents["']\)/,
    'a fence spelled on the bare basename "/incidents" hits the public status page\'s loader, @/lib/docs/incidents (D542)',
  );

  for (const file of LIVE_PAGES) {
    // A page imports its mock COMPONENT by design (it renders the mock
    // branch); what it must never do is read a mock DATA module.
    const specifiers = resolvedImports(page(file), pagePath(file));
    assert.equal(specifiers.some((spec) => /(^|\/)mock\//.test(spec)), false, `${file} must not import any mock data module`);
    assert.equal(specifiers.some((spec) => spec.endsWith("/IncidentRca")), false, `${file} must not import IncidentRca — it types out the fixture's six headings (D552)`);
  }

  for (const name of LIVE_COMPONENTS) {
    const specifiers = resolvedImports(component(name), componentPath(name));
    assert.equal(specifiers.some((spec) => /(^|\/)mock\//.test(spec)), false, `${name} must not import any mock module`);
    // Banned BY NAME so the failure says why: IncidentRca is the fixture's
    // typewriter over the mock's six RCA headings, mock-only and byte-pinned
    // (D552/D556).
    assert.equal(specifiers.some((spec) => spec.endsWith("/IncidentRca")), false, `${name} must not import IncidentRca — it narrates the fixture's RCA (D552)`);
    // Never on this surface; banned prophylactically (packet §0).
    assert.equal(specifiers.some((spec) => spec.endsWith("/TerraformExport")), false, `${name} must not import TerraformExport (D13)`);
    assert.equal(specifiers.some((spec) => /\/Incident(s|Detail)Mock$/.test(spec)), false, `${name} must not import a mock component`);

    const serverSpecs = specifiers.filter((spec) => spec.startsWith("@/server/"));
    if (name === "IncidentRcaRail" || name === "IncidentRcaPanel") {
      // The one permitted `@/server/` specifier is the client-importable wire
      // contract, exactly — a store, the stitcher or the engine would put the
      // query layer in a client bundle (S1.5/D10).
      assert.deepEqual(
        serverSpecs.filter((spec) => spec !== "@/server/explain/contract"),
        [],
        `${name} may import @/server/explain/contract and no other @/server/ module`,
      );
      continue;
    }
    // Reads are the page's (D428/D441): the live components receive rows and
    // query nothing; the editor mutates only through the actions file.
    assert.deepEqual(serverSpecs, [], `${name} must import nothing from @/server/ — the page hands it rows`);
  }
});

test("IncidentsLive and IncidentDetailLive are server components; IncidentEditor and IncidentRcaRail own the client half (D546/D582)", () => {
  assert.ok(!component("IncidentsLive").includes('"use client"'), "IncidentsLive must be a server component (D428)");
  const DETAIL = component("IncidentDetailLive");
  assert.ok(!DETAIL.includes('"use client"'), "IncidentDetailLive must be a server component (D428)");
  assert.ok(component("IncidentEditor").startsWith('"use client";'), "IncidentEditor is the client half (D546)");
  const SECTION = component("IncidentRcaRail");
  assert.ok(SECTION.startsWith('"use client";'), "IncidentRcaRail is the RCA's client owner (D582)");
  assert.ok(component("IncidentRcaPanel").startsWith('"use client";'), "IncidentRcaPanel is a client component (T5)");
  // The panel's `onFinished` is a function prop: a server component cannot
  // pass one, so the detail renders the SECTION and the section renders the
  // panel, owning `prepared` (the answer this page already produced — the RCA
  // is not stored, D555) and `used` (the counter after a run, `usedAfter`).
  assert.doesNotMatch(code(DETAIL), /<IncidentRcaPanel\b/, "IncidentDetailLive cannot render IncidentRcaPanel — it cannot pass onFinished; it renders IncidentRcaRail");
  assert.match(code(DETAIL), /<IncidentRcaRail\b/, "IncidentDetailLive renders the RCA through its client owner");
  assert.match(code(SECTION), /<IncidentRcaPanel\b/, "IncidentRcaRail renders the panel");
  assert.match(code(SECTION), /onFinished=\{/, "IncidentRcaRail passes onFinished — it is the owner of prepared/used");
  assert.match(code(SECTION), /\bprepared=\{/, "IncidentRcaRail hands the retained answer back as `prepared`, so a reopen spends nothing (D555)");
  // The live detail renders the D436 sentence through its one definition.
  assert.match(code(DETAIL), /<IncidentNotFound \/>/, "IncidentDetailLive renders IncidentNotFound for an id the workspace does not hold (D546)");
});

test("the fenced-out mock story is absent from the live surface, not staged (D13/D548)", () => {
  // Facts only the fixture holds, plus the two kinds the live vocabulary does
  // not carry (D537: `pipeline` has no ingest path, `k8s` is out on the S4.4 R3
  // copy fence), the mock's RCA headings (D552) and the status-page link (D547).
  // `22m` is NOT on the list, and deliberately: it is the mock's duration
  // string, but a live formatter emitting `${m}m` never contains the literal,
  // so the assertion could never fire on the defect it names while a comment
  // writing "22m window" would red it for nothing.
  const facts = [
    "INC-42",
    "1 in the last 7 days",
    "zendesk-migration",
    "classify_intent",
    "agent-worker-7d9fb-kx2rq",
    "Retry-After",
    "/v1/tickets/bulk",
    "#llm-costs",
    "Amplifiers",
    "Blast radius",
    "Action items",
    "reconstructed automatically",
    "pipelines",
    "k8s",
    "cluster",
    "Kubernetes",
    '"/status"',
  ];
  const files = [
    ...LIVE_COMPONENTS.map((name) => [name, () => component(name)] as const),
    ...LIVE_PAGES.map((file) => [file, () => page(file)] as const),
  ];
  for (const [what, read] of files) {
    const live = code(read());
    for (const fact of facts) {
      assert.equal(live.includes(fact), false, `${what} carries "${fact}" — a fact about the fixture, not about a live workspace (D13/D548)`);
    }
    // No clock is hand-rolled: the three formatters in `lib/incident-types`
    // are the ONE renderer of an instant, a window and a duration.
    assert.doesNotMatch(live, /\.toLocale(Date|Time)?String\(|\.toUTCString\(/, `${what} renders an instant in the reader's zone — use the incident formatters`);
    assert.doesNotMatch(live, /\.get(UTC)?(Hours|Minutes|Seconds|Date|Month|FullYear)\(/, `${what} hand-rolls a clock — use the incident formatters`);
    assert.doesNotMatch(live, /\.toISOString\(\)\s*\.(slice|substring|substr|split|replace)\(/, `${what} hand-rolls a clock out of an ISO string — use the incident formatters`);
    // A deep link into the traces surface is BUILT from its filter vocabulary,
    // never typed (the slos precedent).
    assert.doesNotMatch(live, /"\/app\/traces\?/, `${what} hand-types a traces query string, which would drift from parseTracesUrl`);
  }
});

test("the pins that keep the absence list from being vacuous: styled vocabularies, the one window formatter, the derived header, the tour anchor (D523/D545/D548)", () => {
  const MOCK = component("IncidentsMock");
  const LIVE = component("IncidentsLive");
  const DETAIL = component("IncidentDetailLive");

  for (const [name, own] of [["IncidentsLive", LIVE], ["IncidentDetailLive", DETAIL]] as const) {
    const graph = code(localGraph(name));
    // BOTH vocabularies are rendered through style tables — status is the
    // mock's two, severity is the alert vocabulary's THREE including `info`
    // (D525): a live vocabulary carrying a member the fixture never used is
    // the S7.3 precedent, where SlosLive added `no-data` to a three-key table.
    for (const status of ["ongoing", "resolved"]) {
      assert.ok(graph.includes(`"${status}"`) || graph.includes(`${status}:`), `${name} has no style for the ${status} status`);
    }
    for (const severity of ["critical", "warning", "info"]) {
      assert.ok(graph.includes(`"${severity}"`) || graph.includes(`${severity}:`), `${name} has no style for the ${severity} severity`);
    }
    // The status pill goes THROUGH the table, indexed by a status value that
    // is the row's own — never a literal text node, which is what the mock's
    // hardcoded `RESOLVED` (page.tsx:37) is and what §0's "never reads
    // inc.status" names. Either shape: a pill component fed `status={row.status}`
    // that indexes `table[status]`, or a direct `table[row.status]`.
    assert.match(graph, /\[(\w+\.)?status\]/, `${name} must index its status style by a status value`);
    const ownCode = code(own);
    assert.match(ownCode, /status=\{\w+\.status\}|\[\w+\.status\]/, `${name} must feed the status pill from the row's own status`);
    assert.doesNotMatch(ownCode, />\s*RESOLVED\s*</, `${name} renders RESOLVED as a literal text node`);
    assert.doesNotMatch(ownCode, /\{\s*["'`]RESOLVED["'`]\s*\}/, `${name} renders RESOLVED as a literal`);
    assert.doesNotMatch(ownCode, />\s*ONGOING\s*</, `${name} renders ONGOING as a literal text node`);
    // The window label comes from the ONE formatter (D527: clamped, one zone).
    assert.match(ownCode, /formatIncidentWindow\(/, `${name} must render the incident's window with formatIncidentWindow`);
  }

  // The list header is DERIVED from the read — `{ongoing} ongoing · {total} total`
  // — and never `1 in the last 7 days` (banned above): the list read applies
  // no time predicate, and reproducing that sentence would claim a filter
  // that does not exist (D545).
  const liveCode = code(LIVE);
  assert.match(liveCode, /ongoing · /, "IncidentsLive must render the derived `{ongoing} ongoing · {total} total` header (D545)");
  assert.match(liveCode, /\btotal\b/, "IncidentsLive must render the total beside the ongoing count (D545)");

  // Every timeline row's instant comes from the ONE clock formatter, seconds
  // included (D527/T2): a rail that prints two rows as `13:05` states they
  // happened at once when the stitch knows they did not.
  assert.match(code(DETAIL), /formatIncidentClock\(/, "IncidentDetailLive must render each row's instant with formatIncidentClock");

  // The tour's anchor survives the flip in BOTH components (D523): on the
  // frozen mock body at line 27 (protected by the pin), and on IncidentsLive's
  // HEADER row — never on a list card, because a zero-incident workspace
  // renders none and TourGuide's missing-anchor path degrades silently.
  assert.ok(MOCK.includes('data-tour="incident"'), 'IncidentsMock dropped data-tour="incident"');
  assert.ok(LIVE.includes('data-tour="incident"'), 'IncidentsLive dropped data-tour="incident"');
});

test("the detail's timeline: two link shapes discriminated by `external`, and each row anchored on its key (D538/D546/D553)", () => {
  const live = code(component("IncidentDetailLive"));
  // `IncidentTimelineEntry.link` carries `external: boolean` as a FIELD, not a
  // branch on kind (D538): a change event's link points OUT to the source
  // system and a trace entry's link is internal by construction. The three
  // assertions `changes/page.test.ts:104-107` pins on ChangesLive are pinned
  // here on the external shape, and the internal shape is pinned beside them:
  // an external link is `<a target="_blank" rel="noopener noreferrer">`, an
  // internal one is `<Link>`, and neither renders as the other.
  assert.match(live, /\.link\.external\b|\bexternal\b/, "the link shape must be chosen on the entry's `external` field (D538)");
  const anchors = [...live.matchAll(/<a\b[\s\S]*?>/g)].map((m) => m[0]).filter((tag) => /\.link\.href\}/.test(tag));
  assert.ok(anchors.length > 0, "an external entry link must render as an anchor with href={….link.href}");
  for (const tag of anchors) {
    assert.match(tag, /target="_blank"/, "an external link opens in a new tab (D499/D538)");
    assert.match(tag, /rel="noopener noreferrer"/, "an external link carries the D499 rel");
  }
  const links = [...live.matchAll(/<Link\b[\s\S]*?>/g)].map((m) => m[0]).filter((tag) => /\.link\.href\}/.test(tag));
  assert.ok(links.length > 0, "an internal entry link (a trace's) must render as a product-internal Link");
  for (const tag of links) {
    assert.doesNotMatch(tag, /target=|rel=/, "an internal Link never carries the external anchor's attributes");
  }
  // Each row is anchored on its key — for an alert or change event the
  // event's own id — so the RCA panel's `#<eventRef>` resolves to the row on
  // this page (D553, the LOGS_ANCHOR pattern).
  assert.match(live, /\bid=\{\w+\.key\}/, "each timeline row must carry id={….key} for the RCA panel's in-page anchors (D553)");
  // The impact box is rendered ONLY when the operator typed one: an
  // `impact ·` frame with nothing after it is a fabricated claim (D546).
  assert.match(live, /impact (!==|===) ""|\.impact &&|impact\.length/, "the impact box must be conditional on a non-empty impact (D546)");
});

test("the detail's honesty states: the omission line is a COUNT, never an instant; the clip and floor registers are D540's (D536 as corrected by D583, D540/D571/D574)", () => {
  const live = code(component("IncidentDetailLive"));
  // D536's example sentence — "alerts after 13:09 are not shown" — is FALSE in
  // cases T4 demonstrated against the real stores (handed forward as F6–F8),
  // and D583 corrects the register to a count:
  //   F6  `omittedAfterIso` names the last row KEPT, so rows dropped AT that
  //       instant make "after X is not shown" false — some rows at X are shown
  //       and some are not;
  //   F7  on the trace leg `first_seen` is whole seconds, so groups routinely
  //       share the boundary instant — a case exists where all 50 kept rows
  //       and the dropped one sit at ONE instant;
  //   F8  `formatIncidentClock` renders seconds, so even an honest boundary
  //       can print the same string as the first dropped row.
  // A count is true in all three: "showing the first 50 of this leg; later
  // rows not shown" (or, for the lead-in band, the rows NEAREST the window
  // with earlier ones not shown — D573). So the surface reads `omissions` for
  // the leg and the band, and never renders either instant.
  assert.match(live, /\bomissions\b/, "IncidentDetailLive must read the per-leg omissions — a capped leg rendered as quiet is D13's gap-as-zero (D536)");
  assert.match(live, /not shown/, "a capped leg is STATED — `… not shown` — never rendered as absence of activity (D536)");
  assert.doesNotMatch(live, /omitted(After|Before)Iso/, "the omission line must not render the boundary instant — it is the last row KEPT, and rows can share it (D583)");
  // D540's three states, in the SHIPPED registers: clipped input carries the
  // D507 line `· ${retentionDays}d retained on ${planName}` (SlosLive's, verbatim),
  // reported by the stitcher as `inputClipped` (D574: derived from the window
  // start it is blind to a floor inside the lead-in band); `outsideRetention`
  // is a bound on the READ — "so no evidence was read for it" — and never a
  // claim that evidence was deleted, which is a past state the product never
  // observed.
  assert.match(live, /\binputClipped\b/, "IncidentDetailLive must render the clip note from the stitcher's inputClipped, not derive it (D574)");
  assert.match(live, /d retained on /, "the clip note is the D507 register: `· ${retentionDays}d retained on ${planName}` (D540)");
  assert.match(live, /\boutsideRetention\b/, "IncidentDetailLive must render the outsideRetention state (D540)");
  assert.match(live, /so no evidence was read for it/, "the floor state is worded as a bound on the read (D540)");
  assert.doesNotMatch(live, /\bdeleted\b|\bswept\b/, "the surface never asserts that evidence was deleted — a past state it never observed (D540)");
  // D586: the empty-window statement counts rows INSIDE the window. The lead-in
  // band is context from the hour before (D535), not a read of the window, so
  // a band-only timeline must still state that nothing was read inside it —
  // the rendered-words review found it rendering three "before the window"
  // rows, no statement about the window, and no RCA control with no sentence
  // for its absence. The statement is decided on the same in-window predicate
  // the control is (D558), so the two can never disagree.
  assert.match(live, /were read inside this window/, "the empty-window state is a statement about the READ inside the window (D537/D586)");
  assert.match(
    live,
    /entry\.kind !== "resolved" && entry\.at >= timeline\.windowStartIso/,
    "the empty-window statement must be decided on entries INSIDE the window — the band is not a read of it (D586)",
  );
});
