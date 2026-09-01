import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// D431's guards for the two dashboards routes, read from SOURCE. Importing the
// real modules here is not an option: `DashboardsMock`/`DashboardDetailMock`/
// `DashboardEditor`/`AddWidgetLive`/`WidgetLive` are `"use client"`, and
// `WidgetLive` pulls recharts in, which extends a React class this
// `--conditions react-server` build does not export (measured in
// `explore/page.test.ts`, the precedent this file follows).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(path.join(HERE, file), "utf8");

const LIST_PAGE = read("page.tsx");
const DETAIL_PAGE = read("[id]/page.tsx");

const component = (name: string) => read(`../../../components/dashboards/${name}.tsx`);
const LIST_MOCK = component("DashboardsMock");
const DETAIL_MOCK = component("DashboardDetailMock");
const LIST_LIVE = component("DashboardsLive");
const DETAIL_LIVE = component("DashboardDetailLive");
const EDITOR = component("DashboardEditor");
const ADD_WIDGET = component("AddWidgetLive");
const WIDGET = component("WidgetLive");

test("both mock branches return before the first await (D431)", () => {
  assert.match(
    LIST_PAGE,
    /if \(dataMode !== "live"\) return <DashboardsMock \/>;/,
    "the list page's mock branch must return DashboardsMock with no props, and nothing else",
  );
  // The `params` PROMISE, unawaited (`services/[id]/page.tsx:33`): the moved
  // body awaits it exactly as it always did, which is what keeps this branch
  // ahead of every await on the page.
  assert.match(
    DETAIL_PAGE,
    /if \(dataMode !== "live"\) return <DashboardDetailMock params=\{params\} \/>;/,
    "the detail page's mock branch must hand the mock the UNAWAITED params promise",
  );

  // Comments stripped first: both pages EXPLAIN the awaits they are ordered
  // against, and prose about an await is not an await.
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  for (const [route, source] of [
    ["page.tsx", code(LIST_PAGE)],
    ["[id]/page.tsx", code(DETAIL_PAGE)],
  ] as const) {
    const branch = source.indexOf('if (dataMode !== "live")');
    const firstAwait = source.indexOf("await ");
    assert.ok(branch >= 0, `${route} must branch on dataMode`);
    assert.ok(
      firstAwait > branch,
      `${route} runs an await before its mock branch — mock mode would pay for a live-only read`,
    );
  }
});

test("the mock bodies are master's two page bodies, byte for byte, modulo the export line (D438)", () => {
  // The pin is the sha256 of the file as `master` holds it. Regenerate with:
  //   git show master:apps/web/src/app/app/dashboards/page.tsx | shasum -a 256
  //   git show 'master:apps/web/src/app/app/dashboards/[id]/page.tsx' | shasum -a 256
  // A failing assertion here means the moved body DRIFTED — the mock route's
  // DOM is no longer the one production renders today, which D438 forbids on
  // all four mock routes. Diff it:
  //   diff <(git show master:apps/web/src/app/app/dashboards/page.tsx) \
  //        src/components/dashboards/DashboardsMock.tsx
  const cases = [
    {
      what: "DashboardsMock.tsx",
      source: LIST_MOCK,
      moved: "export function DashboardsMock() {",
      original: "export default function DashboardsPage() {",
      sha: "bb9e01e304fb7fbc26b90cad91ffc23d871cb084dea90ff723aaf7e600941343",
    },
    {
      what: "DashboardDetailMock.tsx",
      source: DETAIL_MOCK,
      moved: "export function DashboardDetailMock({ params }: { params: Promise<{ id: string }> }) {",
      original:
        "export default function DashboardDetailPage({ params }: { params: Promise<{ id: string }> }) {",
      sha: "0a3a3ffcde3c6dac18356abb7a085f8fab346f7bac4a1642135b1a6247a62ab5",
    },
  ];

  for (const { what, source, moved, original, sha } of cases) {
    assert.ok(source.startsWith('"use client";'), `${what} must stay the client body it was`);
    assert.ok(source.includes(moved), `${what} must export exactly \`${moved}\``);
    const digest = createHash("sha256").update(source.replace(moved, original)).digest("hex");
    assert.equal(digest, sha, `${what} is no longer master's page body modulo the export line (D438)`);
  }
});

test("the live dashboards graph never reaches back into the mock product (D431/D391)", () => {
  const files = [
    ["DashboardsLive.tsx", LIST_LIVE],
    ["DashboardDetailLive.tsx", DETAIL_LIVE],
    ["DashboardEditor.tsx", EDITOR],
    ["AddWidgetLive.tsx", ADD_WIDGET],
    // T2's hand-off: the card the live pages render is part of the same graph.
    ["WidgetLive.tsx", WIDGET],
  ] as const;

  for (const [what, source] of files) {
    assert.equal(source.includes('from "@/mock/'), false, `${what} must not import any mock module`);
    // The INDIRECT routes back into the mock product: the workspace store is
    // the in-memory dashboards the mock pages mutate, `WidgetCard` calls
    // `exploreSeries()` from `@/mock/explore` internally, `AddWidgetModal`
    // picks from the fixture catalog, and `ExploreChart` drags `@/mock/explore`
    // in the same way. None of them show up in the `@/mock/` check above.
    assert.equal(
      /from "@\/state\/workspace-store"/.test(source),
      false,
      `${what} must not read the mock workspace store — live dashboards live in Postgres`,
    );
    for (const mockOnly of ["WidgetCard", "AddWidgetModal", "ExploreChart"]) {
      assert.equal(
        new RegExp(`from "@/components/[a-z]+/${mockOnly}"`).test(source),
        false,
        `${what} must not import ${mockOnly} — it is mock-only by construction (D391)`,
      );
    }
  }
});

test("the two Live files are server components (D428: pages read, Live renders)", () => {
  for (const [what, source] of [
    ["DashboardsLive.tsx", LIST_LIVE],
    ["DashboardDetailLive.tsx", DETAIL_LIVE],
  ] as const) {
    assert.equal(
      source.includes('"use client"'),
      false,
      `${what} must stay a server component — its props are already resolved`,
    );
  }
});

test("the live surface prints the D436 sentences verbatim", () => {
  assert.ok(
    LIST_LIVE.includes("no dashboards yet — create one, or save a chart from Explore"),
    "the empty list sentence must be the ruled one (D436)",
  );
  assert.ok(
    DETAIL_LIVE.includes("no dashboard with this id in your workspace"),
    "an unknown or foreign id must answer with the ruled sentence (D436)",
  );
  assert.ok(DETAIL_LIVE.includes("← back to dashboards"), "the not-found answer must link back (D436)");
  assert.ok(EDITOR.includes("no widgets yet — add one"), "an empty dashboard must say so (D436)");
});
