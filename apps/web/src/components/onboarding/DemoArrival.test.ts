import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// run with: npm test --workspace apps/web
//
// The pin that followed the component (D217): the quickstart's demo arrival —
// the mock trace link and the timed flip it plays instead of waiting for an
// ingest it does not have — lives HERE, in the one onboarding module that
// imports `@/mock/traces`, and reaches the live surface only as a prop the
// mock-mode caller passes.
//
// Text, not import: these are `"use client"` components and the runner is pinned
// to `--conditions react-server`, which cannot load one (D54(ii)).

const HERE = import.meta.dirname;

const source = readFileSync(path.join(HERE, "DemoArrival.tsx"), "utf8");
const page = readFileSync(
  path.join(HERE, "../../app/app/onboarding/page.tsx"),
  "utf8",
);

test("the mock trace link and its timer live in this component", () => {
  assert.match(source, /import \{ allTraces \} from "@\/mock\/traces";/);
  assert.ok(source.includes("allTraces.find"), "the mock trace link belongs to the demo panel");
  // D125 protects the demo's DATA: the flip stays timed, and stays instant for
  // a reader who asked for less motion.
  assert.match(source, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
  assert.match(source, /setTimeout\(\(\) => setArrived\(true\), reduced \? 0 : 5000\)/);
});

test("only the page's mock branch reaches this module", () => {
  assert.match(page, /import \{ DemoArrival \} from "@\/components\/onboarding\/DemoArrival";/);
  const mockBranch = page.slice(page.indexOf('if (dataMode !== "live")'));
  const live = mockBranch.slice(mockBranch.indexOf("\n"));
  assert.ok(
    mockBranch.startsWith('if (dataMode !== "live") return <Quickstart demoArrival={<DemoArrival />} />;'),
    "the demo panel is handed to Quickstart from the mock branch",
  );
  assert.equal(live.includes("DemoArrival"), false, "the live render must not name the demo panel");
});
