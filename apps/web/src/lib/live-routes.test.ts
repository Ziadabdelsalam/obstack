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

// T3 (E11/E15): `/app/logs` reads `obstack.logs` in live mode, so the SAMPLE
// badge must be gone there — and this assertion has to observe the REGISTRATION
// rather than the page (S2.0 L1): delete the `/app/logs` entry from
// `liveWiredRoutes` and it goes red, which is exactly what `SampleDataBadge`
// would do on the route itself. The exact-match line below is the other half —
// the entry carries no trailing slash, so it must not wire a subtree the way
// `/app/traces/` deliberately does.
test("/app/logs is live-wired, exactly and not as a subtree", () => {
  assert.equal(isLiveWiredRoute("/app/logs"), true);
  assert.equal(isLiveWiredRoute("/app/logs/anything"), false);
});
