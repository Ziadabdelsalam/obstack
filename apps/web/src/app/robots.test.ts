import assert from "node:assert/strict";
import test from "node:test";
import robots from "./robots";

// run with: npm test --workspace apps/web
//
// D340(f): the live app has nothing for a crawler to index; the mock
// marketing/demo image is the public surface and stays open. DEFAULT-DENY:
// only the literal "mock" allows — unset, "live" and garbage all disallow, so
// a misconfigured deployment never accidentally opens itself to indexing.

function reset(): void {
  delete process.env.OBSTACK_DATA_MODE;
}

test("unset (the live default): every agent disallowed", () => {
  reset();
  assert.deepEqual(robots(), { rules: { userAgent: "*", disallow: "/" } });
});

test("live: every agent disallowed", () => {
  reset();
  process.env.OBSTACK_DATA_MODE = "live";
  assert.deepEqual(robots(), { rules: { userAgent: "*", disallow: "/" } });
  reset();
});

test("mock: every agent allowed", () => {
  reset();
  process.env.OBSTACK_DATA_MODE = "mock";
  assert.deepEqual(robots(), { rules: { userAgent: "*", allow: "/" } });
  reset();
});

test("garbage value: default-deny, not default-allow", () => {
  reset();
  process.env.OBSTACK_DATA_MODE = "not-a-real-mode";
  assert.deepEqual(robots(), { rules: { userAgent: "*", disallow: "/" } });
  reset();
});
