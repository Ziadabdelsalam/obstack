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

// T5 (D106): `/app/settings` reads the session's org, members, invites and API
// keys in live mode, so the route-wide badge must be gone — the four tabs that
// are still demo content say so themselves with `SampleMark`. Same registration
// assertion as the line above (S2.0 L1): drop the entry and this goes red, which
// is exactly what `SampleDataBadge` would then do on the route.
test("/app/settings is live-wired, exactly and not as a subtree", () => {
  assert.equal(isLiveWiredRoute("/app/settings"), true);
  assert.equal(isLiveWiredRoute("/app/settings/anything"), false);
});

// S3.4 T5 (D106): the quickstart renders the workspace's own issued key and
// polls its real ingest counters, and the hub renders that workspace's sources
// with their D100 health — neither route renders sample content any more, so
// the badge must be gone from both. Registration, not the pages (S2.0 L1), and
// exact entries: nothing lives under either path, and a trailing-slash entry
// would wire a subtree that does not exist.
test("/app/onboarding and /app/connections are live-wired, exactly", () => {
  assert.equal(isLiveWiredRoute("/app/onboarding"), true);
  assert.equal(isLiveWiredRoute("/app/onboarding/anything"), false);
  assert.equal(isLiveWiredRoute("/app/connections"), true);
  assert.equal(isLiveWiredRoute("/app/connections/anything"), false);
});

// D205: the e2e drive's SAMPLE-badge positive control is `/app/costs`, and this
// sprint wires neither it nor any other unwired route — a registration that
// silently vacated that control would leave the drive asserting nothing. The
// line goes red the moment `/app/costs` (or the `/app/` subtree) is registered.
test("/app/costs stays unwired — the drive's positive control (D205)", () => {
  assert.equal(isLiveWiredRoute("/app/costs"), false);
});
