import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isLiveWiredRoute } from "@/lib/live-routes";

// run with: npm test --workspace apps/web
//
// The checklist's row derivation, driven directly. `OnboardingChecklist.tsx` is
// a `"use client"` module and the runner is pinned to `--conditions
// react-server` (D54(ii)): its `next/link` and `lucide-react` imports both call
// `createContext`, which that React build does not have. The decision under test
// is pure, so this file stubs the two poison specifiers at the CJS `require`
// seam tsx compiles the imports to (the `ConnectionsHub.test.tsx` pattern),
// loads the module and asserts the exported function alone.
const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "next/link") return { __esModule: true, default: () => null };
  if (request === "lucide-react")
    return { __esModule: true, Check: () => null, X: () => null, ArrowRight: () => null };
  return origLoad.call(this, request, ...rest);
};

const { checklistSteps, DEMO_CHECKLIST_FLAGS, tryNext } = createRequire(
  fileURLToPath(import.meta.url),
)("./OnboardingChecklist.tsx") as typeof import("./OnboardingChecklist");

const doneLabels = (flags: Parameters<typeof checklistSteps>[0]) =>
  checklistSteps(flags).filter((s) => s.done).map((s) => s.label);

// The defect D211 names: `/app` is live-wired, and every one of these rows said
// "done" to a workspace that had sent nothing and invited nobody.
test("a brand-new live workspace has NOTHING ticked", () => {
  assert.deepEqual(
    doneLabels({ sourceConnected: false, firstTrace: false, teamInvited: false }),
    [],
  );
});

test("each live flag ticks its own row and no other", () => {
  assert.deepEqual(doneLabels({ sourceConnected: true, firstTrace: false, teamInvited: false }), [
    "Connect a source",
  ]);
  assert.deepEqual(doneLabels({ sourceConnected: true, firstTrace: true, teamInvited: false }), [
    "Connect a source",
    "See your first trace",
  ]);
  assert.deepEqual(doneLabels({ sourceConnected: false, firstTrace: false, teamInvited: true }), [
    "Invite your team",
  ]);
});

// The D203 window this encodes: health says arrived before the row is
// queryable, so "connected" ticks and "first trace" does not — the same split
// the quickstart's waiting panel makes on the same status object.
test("arrived-but-not-yet-queryable ticks the source row only", () => {
  const steps = checklistSteps({ sourceConnected: true, firstTrace: false, teamInvited: false });
  assert.equal(steps[0].done, true);
  assert.equal(steps[1].done, false);
});

// R3 should-fix 3 — THE CHECKLIST CAN BE FINISHED.
//
// R2 replaced two rows that pointed at unbuilt surfaces with two that point at
// shipped ones, but left them hardcoded `done: false` with no flag able to
// reach them: a live workspace that had connected a source, seen a trace and
// invited its team read `setup · 3/5` forever, beside two checkboxes nothing
// could ever tick. A permanent 3/5 is a false statement about the workspace in
// the same way a false tick is, so the rule is now structural rather than a
// count of rows: every ROW is flag-derived, and the suggestions that are not
// derivable are not rows.
test("every step is derived from a flag — a finished workspace reads N/N", () => {
  const steps = checklistSteps({ sourceConnected: true, firstTrace: true, teamInvited: true });
  assert.deepEqual(
    steps.filter((s) => !s.done),
    [],
    "a step stayed false with every flag true — an untickable checkbox is back",
  );
  assert.equal(steps.length, 3, "the checklist's shape changed — the dashboard reads `setup · N/3`");
});

test("the suggestions are not steps: no `done`, so nothing renders a box", () => {
  assert.ok(tryNext.length > 0, "the try-next rail is empty — the rows went nowhere, not sideways");
  for (const s of tryNext) {
    assert.equal(
      "done" in s,
      false,
      `"${s.label}" carries a done flag — it is a step again, and nothing derives it`,
    );
  }
});

// Mock mode renders what it always rendered for the three derived rows (D125).
test("the demo flags tick every step", () => {
  assert.deepEqual(
    checklistSteps(DEMO_CHECKLIST_FLAGS).map((s) => [s.label, s.done, s.href]),
    [
      ["Connect a source", true, "/app/connections"],
      ["See your first trace", true, "/app/traces"],
      ["Invite your team", true, "/app/settings"],
    ],
  );
  assert.deepEqual(
    tryNext.map((s) => [s.label, s.href]),
    [
      ["Explain a failing trace", "/app/traces?status=error"],
      ["Search your logs", "/app/logs"],
    ],
  );
});

// The fourth row used to send the reader to `/app/traces` — the same
// destination as the second row, so the checklist's fourth item was a second
// copy of its second. Two rows on one strip pointing at one page is a reader
// clicking twice to arrive where they already were.
test("no two rows on the strip share a destination", () => {
  const hrefs = [...checklistSteps(DEMO_CHECKLIST_FLAGS), ...tryNext].map((s) => s.href);
  assert.equal(
    new Set(hrefs).size,
    hrefs.length,
    `two rows point at the same place: ${hrefs.join(", ")}`,
  );
});

// R2 should-fix 3, as an invariant rather than a set of pinned strings: the two
// replaced rows were not wrong because of how they were worded, they were wrong
// because they pointed at surfaces that render sample content in a live
// workspace. `lib/live-routes.ts` is the product's own answer to which routes
// read real data (D21), so the checklist is checked against it — a sixth row
// added next sprint joins this by existing.
test("every row sends the reader somewhere the product actually wired", () => {
  // Steps and suggestions alike: a suggestion that pointed at an unbuilt
  // surface would be the R2 defect wearing the new shape.
  const rows = [...checklistSteps(DEMO_CHECKLIST_FLAGS), ...tryNext];
  for (const s of rows) {
    // `isLiveWiredRoute` answers about a PATHNAME (it is fed `usePathname()`
    // everywhere else), and a filtered link carries a query — so the query is
    // dropped here rather than taught to the predicate.
    const pathname = s.href.split(/[?#]/)[0];
    assert.equal(
      isLiveWiredRoute(pathname),
      true,
      `"${s.label}" points at ${s.href}, which is not a live-wired route — an unbuilt errand on the setup checklist`,
    );
  }
  // Not vacuous: an unwired route is exactly what the predicate refuses,
  // which is the reason the rows changed. (/app/alerts left this pair at
  // S7.1 and /app/slos at S7.3 when they wired; /app/incidents and
  // /app/oncall are the two controls now.)
  assert.equal(isLiveWiredRoute("/app/incidents"), false);
  assert.equal(isLiveWiredRoute("/app/oncall"), false);
});
