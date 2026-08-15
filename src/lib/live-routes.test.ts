import assert from "node:assert/strict";
import test from "node:test";
import { isLiveWiredRoute } from "./live-routes";

test("live-wired registry matches wired prefixes minus named exceptions", () => {
  assert.equal(isLiveWiredRoute("/app"), true);
  assert.equal(isLiveWiredRoute("/app/traces"), true);
  assert.equal(isLiveWiredRoute("/app/traces/3a55f0efeeb800e757fd61001b7cff2e"), true);
  assert.equal(isLiveWiredRoute("/app/traces/diff"), false);
  assert.equal(isLiveWiredRoute("/app/alerts"), false);
  assert.equal(isLiveWiredRoute("/app/services"), false);
});
