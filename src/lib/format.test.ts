import assert from "node:assert/strict";
import test from "node:test";
import { fmtCost } from "./format";

test("fmtCost never renders a real cost as zero", () => {
  // the smoke trace: a few hundred-thousandths of a dollar
  assert.equal(fmtCost(0.00003), "$0.00003");
  assert.equal(fmtCost(0.000099), "$0.000099");
  assert.equal(fmtCost(0.0000001), "$0.0000001");
  assert.equal(fmtCost(1e-11), "$0.00000000001");
  assert.equal(fmtCost(0), "—");
});

test("fmtCost keeps the established shape for everything 4dp can express", () => {
  assert.equal(fmtCost(0.0001), "$0.0001");
  assert.equal(fmtCost(0.0006), "$0.0006");
  assert.equal(fmtCost(0.0049), "$0.0049");
  assert.equal(fmtCost(0.01), "$0.01");
  assert.equal(fmtCost(81.4), "$81.40");
});
