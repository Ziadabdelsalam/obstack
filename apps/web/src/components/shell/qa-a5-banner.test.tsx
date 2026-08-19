import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

// run with: npm test --workspace apps/web
//
// The usage banner's show-or-not math, driven directly. `UsageBanner.tsx` is a
// `"use client"` module and the runner is pinned to `--conditions react-server`
// (D54(ii)): its top-level `next/link` and `lucide-react` imports both call
// `createContext`, which that React build does not have, so the module cannot be
// imported the way `TracesSearch.test.tsx` describes. The decision under test is
// pure, though — `usageBannerNotice(used, quota)` touches neither of those — so
// this file stubs the two poison specifiers at the CJS `require` seam tsx compiles
// the imports to, loads the module, and asserts the function alone. The component
// body (the hooks, the JSX) is never run; only the exported predicate is.
//
// The patch is scoped to two specifiers and delegates everything else, and node's
// test runner gives each test file its own child process, so nothing here reaches
// another suite.
const origLoad = (Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load;
(Module as unknown as { _load: (r: string, ...a: unknown[]) => unknown })._load = function (
  request: string,
  ...rest: unknown[]
) {
  if (request === "next/link") return { __esModule: true, default: () => null };
  if (request === "lucide-react") return { __esModule: true, X: () => null };
  return origLoad.call(this, request, ...rest);
};

const { usageBannerNotice } = createRequire(fileURLToPath(import.meta.url))(
  "./UsageBanner.tsx",
) as typeof import("./UsageBanner");

// B5-1: a zero or absent quota is degenerate — the divide is Infinity or NaN, not
// a percentage. The banner must render nothing rather than "Infinity% used" or a
// false "sampling active". Red-provable by dropping the `eventQuota > 0` guard:
// with it gone, `12_345 / 0` is Infinity, `Infinity < 70` is false, and the
// function returns a notice with `pct: Infinity` instead of null.
test("B5-1: a zero / degenerate quota suppresses the banner", () => {
  assert.equal(usageBannerNotice(12_345, 0), null, "events over a zero quota is no percentage");
  assert.equal(usageBannerNotice(0, 0), null, "a never-metered workspace raises nothing");
  assert.equal(usageBannerNotice(1, -50), null, "a negative quota is degenerate too");
  // The control: a real quota at the same usage DOES surface, so the nulls above
  // are the guard firing and not the function refusing everything.
  assert.notEqual(usageBannerNotice(12_345, 15_000), null);
});

// B5-2: the banner appears from 70.0% on, not 69.5%. The threshold is compared
// against the UNROUNDED ratio; rounding is for the printed number only.
// Red-provable by comparing the rounded percentage instead: `Math.round(69.5)` is
// 70, which is not `< 70`, so 34750/50000 would surface half a point early.
test("B5-2: the threshold reads the unrounded ratio, not the rounded percentage", () => {
  assert.equal(usageBannerNotice(34_750, 50_000), null, "69.5% is below the 70% line");
  assert.equal(usageBannerNotice(34_999, 50_000), null, "just under 70% stays hidden");
  // The boundary itself, and the control that the nulls above are a real cut-off:
  // 70.0% exactly surfaces, and its printed percentage is the honest 70.
  const at70 = usageBannerNotice(35_000, 50_000);
  assert.notEqual(at70, null, "70.0% surfaces");
  assert.equal(at70?.pct, 70);
});

// The unclamped, honest overage the copy depends on (D163): at and past the quota
// the notice reports over-quota, and the percentage is not capped at 100.
test("over quota is reported unclamped", () => {
  const atQuota = usageBannerNotice(50_000, 50_000);
  assert.equal(atQuota?.overQuota, true, "AT the quota counts as over (D163)");
  const past = usageBannerNotice(66_500, 50_000);
  assert.equal(past?.overQuota, true);
  assert.equal(past?.pct, 133, "a workspace a third over is told 133%, not a tidy 100%");
});
