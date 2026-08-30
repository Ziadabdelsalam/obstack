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

const { checklistSteps, DEMO_CHECKLIST_FLAGS } = createRequire(fileURLToPath(import.meta.url))(
  "./OnboardingChecklist.tsx",
) as typeof import("./OnboardingChecklist");

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

// No flag reaches the last two rows, so no input can tick them (R2 should-fix
// 3 replaced their labels; the invariant is unchanged).
test("the last two rows are false whatever the flags say", () => {
  for (const flags of [
    { sourceConnected: true, firstTrace: true, teamInvited: true },
    { sourceConnected: false, firstTrace: false, teamInvited: false },
  ]) {
    const steps = checklistSteps(flags);
    assert.deepEqual(
      steps.slice(3).map((s) => [s.label, s.done]),
      [
        ["Explain a trace", false],
        ["Search your logs", false],
      ],
    );
  }
});

// Mock mode renders exactly what it always rendered (D125): the first three
// ticked, the last two not — the hardcoded list this module used to hold.
test("the demo flags reproduce today's mock render", () => {
  assert.deepEqual(
    checklistSteps(DEMO_CHECKLIST_FLAGS).map((s) => [s.label, s.done, s.href]),
    [
      ["Connect a source", true, "/app/connections"],
      ["See your first trace", true, "/app/traces"],
      ["Invite your team", true, "/app/settings"],
      ["Explain a trace", false, "/app/traces"],
      ["Search your logs", false, "/app/logs"],
    ],
  );
});

// R2 should-fix 3, as an invariant rather than a set of pinned strings: the two
// replaced rows were not wrong because of how they were worded, they were wrong
// because they pointed at surfaces that render sample content in a live
// workspace. `lib/live-routes.ts` is the product's own answer to which routes
// read real data (D21), so the checklist is checked against it — a sixth row
// added next sprint joins this by existing.
test("every row sends the reader somewhere the product actually wired", () => {
  const steps = checklistSteps(DEMO_CHECKLIST_FLAGS);
  assert.equal(steps.length, 5, "the checklist's shape changed — the dashboard reads `setup · N/5`");
  for (const s of steps) {
    assert.equal(
      isLiveWiredRoute(s.href),
      true,
      `"${s.label}" points at ${s.href}, which is not a live-wired route — an unbuilt errand on the setup checklist`,
    );
  }
  // Not vacuous: the two routes this replaced are exactly what the predicate
  // refuses, which is the reason the rows changed.
  assert.equal(isLiveWiredRoute("/app/slos"), false);
  assert.equal(isLiveWiredRoute("/app/alerts"), false);
});
