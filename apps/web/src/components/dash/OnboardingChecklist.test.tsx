import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

// Unbuilt surfaces (M5): no flag reaches them, so no input can tick them.
test("SLO and alert rows are false whatever the flags say", () => {
  for (const flags of [
    { sourceConnected: true, firstTrace: true, teamInvited: true },
    { sourceConnected: false, firstTrace: false, teamInvited: false },
  ]) {
    const steps = checklistSteps(flags);
    assert.deepEqual(
      steps.slice(3).map((s) => [s.label, s.done]),
      [
        ["Create an SLO", false],
        ["Route alerts to Slack", false],
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
      ["Create an SLO", false, "/app/slos"],
      ["Route alerts to Slack", false, "/app/alerts"],
    ],
  );
});
