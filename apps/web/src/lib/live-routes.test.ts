import assert from "node:assert/strict";
import test from "node:test";
import { isLiveWiredRoute, isProductChromeRoute, liveWiredRoutes } from "./live-routes";

test("live-wired registry matches wired prefixes minus named exceptions", () => {
  assert.equal(isLiveWiredRoute("/app"), true);
  assert.equal(isLiveWiredRoute("/app/traces"), true);
  assert.equal(isLiveWiredRoute("/app/traces/3a55f0efeeb800e757fd61001b7cff2e"), true);
  // The unwired control is this registry's own non-vacuity line: a route that
  // is genuinely NOT wired, so the predicate is seen refusing something. It has
  // rotated as M6 wired its surfaces — /app/alerts held it until S7.1 wired
  // alerts, /app/slos until S7.3 wired slos, /app/incidents until S7.4 wired
  // incidents (D522) — and it now sits on /app/pipelines, M7's opener, unwired
  // past S7.5. Deliberately NOT /app/oncall, which S7.5 wires next sprint: a
  // control that expires in one sprint has to be moved every sprint, and a
  // move is a chance to forget. (/app/ask, below, is the e2e drive's SAMPLE
  // positive control — a different job, and it stays where it is.)
  assert.equal(isLiveWiredRoute("/app/pipelines"), false);
});

// S8.1 (D21/D656): the MCP page reads this workspace's admitted keys and the
// operator's published address in live mode — wired exactly, not as a subtree
// (the page has no children; the endpoint itself lives at /mcp, outside /app).
test("/app/mcp is live-wired, exactly and not as a subtree", () => {
  assert.equal(isLiveWiredRoute("/app/mcp"), true);
  assert.equal(isLiveWiredRoute("/app/mcp/anything"), false);
  assert.equal(isLiveWiredRoute("/mcp"), false, "the endpoint is not a page and carries no badge");
});

// D707 (D21): the account page reads the signed-in person's own user row,
// session rows and memberships from Postgres in live mode — wired exactly,
// not as a subtree (nothing lives under it). Registration, not the page (S2.0
// L1): drop the entry and this goes red, which is exactly what `SampleDataBadge`
// would then do over a person's own name and sessions.
test("/app/account is live-wired, exactly and not as a subtree", () => {
  assert.equal(isLiveWiredRoute("/app/account"), true);
  assert.equal(isLiveWiredRoute("/app/account/anything"), false);
});

// S7.3 (D21/D514): slos reads the workspace's own objectives, measured by the
// ingest binary's evaluator, in live mode — wired exactly, not as a subtree.
test("/app/slos is live-wired, exactly and not as a subtree", () => {
  assert.equal(isLiveWiredRoute("/app/slos"), true);
  assert.equal(isLiveWiredRoute("/app/slos/anything"), false);
});

// S7.4 (D21/D522): the list reads this workspace's own `incidents` rows from
// Postgres and an incident's page stitches its timeline over that workspace's
// own alerts, changes and error traces, so the SAMPLE badge must be gone from
// BOTH — registration, not the pages (S2.0 L1). Wired twice for the
// `/app/dashboards` reason: the exact entry is the list, the trailing-slash
// entry is one incident's own page under it, which is a different page. The
// pair is not decorative — `startsWith("/app/incidents/")` is false for
// `/app/incidents`, and an exact-only entry would badge the detail "SAMPLE
// DATA" over the workspace's own data, the inverse lie D21 exists to prevent.
// Drop either line and this goes red, which is exactly what `SampleDataBadge`
// would then do on that URL.
test("/app/incidents and one incident under it are live-wired", () => {
  assert.equal(isLiveWiredRoute("/app/incidents"), true);
  assert.equal(isLiveWiredRoute("/app/incidents/inc_0123456789abcdef"), true);
});

// S7.1 (D21/D367): alerts reads the workspace's own rules, evaluated events
// and channels in live mode — wired exactly, not as a subtree.
test("/app/alerts is live-wired, exactly and not as a subtree", () => {
  assert.equal(isLiveWiredRoute("/app/alerts"), true);
  assert.equal(isLiveWiredRoute("/app/alerts/anything"), false);
});

// S7.2 (D21/D502): changes reads the workspace's own change events in live
// mode — wired exactly, not as a subtree.
test("/app/changes is live-wired, exactly and not as a subtree", () => {
  assert.equal(isLiveWiredRoute("/app/changes"), true);
  assert.equal(isLiveWiredRoute("/app/changes/anything"), false);
});

// S6.2 (D21/D367): the five trace-derived surfaces read the signed-in
// workspace's own spans in live mode, so the SAMPLE badge must be gone from all
// of them — registration, not the pages (S2.0 L1). `/app/services` is wired
// TWICE on purpose: the exact entry for the catalog, the trailing-slash entry
// for a service's own scorecard under it, which is a different page.
test("the S6.2 five are live-wired, the services subtree included", () => {
  assert.equal(isLiveWiredRoute("/app/map"), true);
  assert.equal(isLiveWiredRoute("/app/map/anything"), false);
  assert.equal(isLiveWiredRoute("/app/services"), true);
  assert.equal(isLiveWiredRoute("/app/services/exit-agent"), true);
  assert.equal(isLiveWiredRoute("/app/users"), true);
  assert.equal(isLiveWiredRoute("/app/users/anything"), false);
  assert.equal(isLiveWiredRoute("/app/issues"), true);
  assert.equal(isLiveWiredRoute("/app/issues/anything"), false);
});

// S6.2 T5 (D400): the diff renders two of the workspace's REAL traces, so the
// carve-out that kept it badged inside the wired `/app/traces/` subtree is gone
// — and with it the whole exclusion list, which held nothing else. This line is
// what goes red if a carve-out is ever reintroduced silently.
test("/app/traces/diff is wired by the trace subtree — nothing is carved out of it", () => {
  assert.equal(isLiveWiredRoute("/app/traces/diff"), true);
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

// S6.1 T7 (D367/D21): explore reads T6's frozen metrics contract in live mode,
// so the SAMPLE badge must be gone there — registration, not the page (S2.0
// L1), same as every other entry above.
test("/app/explore is live-wired, exactly", () => {
  assert.equal(isLiveWiredRoute("/app/explore"), true);
  assert.equal(isLiveWiredRoute("/app/explore/anything"), false);
});

// S6.3 T6 (D21/D367/D431): the list reads this workspace's own `dashboards`
// rows and a dashboard's page reads its widgets through the metrics contract,
// so the SAMPLE badge must be gone from BOTH — registration, not the pages
// (S2.0 L1). Wired twice for the `/app/services` reason: the exact entry is the
// list, the trailing-slash entry is one dashboard's own page under it, which is
// a different page. Drop either line and the drive's badge claim on that URL
// goes red, which is exactly what `SampleDataBadge` would then do on it.
test("/app/dashboards and one dashboard under it are live-wired", () => {
  assert.equal(isLiveWiredRoute("/app/dashboards"), true);
  assert.equal(isLiveWiredRoute("/app/dashboards/dash_0123456789abcdef"), true);
});

// S6.4 T7 (D21/D367/D463): `/app/infra` renders the nodes and pods the
// workspace's own collector reports through the S6.1 metric store, and
// `/app/costs` renders the LLM spend its own traces carry, so the SAMPLE badge
// must be gone from both — registration, not the pages (S2.0 L1). Exact
// entries, no trailing slash: nothing lives under either path, and a
// trailing-slash entry would wire a subtree that does not exist.
test("/app/infra and /app/costs are live-wired, exactly", () => {
  assert.equal(isLiveWiredRoute("/app/infra"), true);
  assert.equal(isLiveWiredRoute("/app/infra/anything"), false);
  assert.equal(isLiveWiredRoute("/app/costs"), true);
  assert.equal(isLiveWiredRoute("/app/costs/anything"), false);
});

// D205/D463: the e2e drive's SAMPLE-badge positive control moved to `/app/ask`
// when this sprint wired `/app/costs`, which had held the job since S3.1. The
// control has to be a route that is genuinely not wired, and a registration
// that silently vacated it would leave the drive asserting nothing — so this
// line goes red the moment `/app/ask` (or the `/app/` subtree) is registered,
// which is the moment the drive needs to pick its next one.
test("/app/ask stays unwired — the drive's positive control (D205/D463)", () => {
  assert.equal(isLiveWiredRoute("/app/ask"), false);
});

// S4.4 T1 (D321): the THIRD class. `/app/docs` reads no workspace data in
// either mode and renders the same corpus the public `/docs` serves, so it is
// neither wired nor sample — and both of the existing labels are false about
// it. Registration again, not the pages (S2.0 L1): the badge, the demo footer
// and the palette's hint all read this predicate, so the three of them follow
// these lines.
test("/app/docs and everything under it is product chrome", () => {
  assert.equal(isProductChromeRoute("/app/docs"), true);
  assert.equal(isProductChromeRoute("/app/docs/quickstart"), true);
  assert.equal(isProductChromeRoute("/app/docs/sdks/typescript"), true);
});

test("product chrome is a narrow class — no data surface falls into it", () => {
  assert.equal(isProductChromeRoute("/app/traces"), false);
  assert.equal(isProductChromeRoute("/app"), false);
  assert.equal(isProductChromeRoute("/app/costs"), false);
  // A prefix of the mount is not the mount: `/app/documents` must not inherit
  // the docs' silence from a careless `startsWith`.
  assert.equal(isProductChromeRoute("/app/documents"), false);
});

// The two classes stay disjoint by construction. Smuggling `/app/docs` into
// `liveWiredRoutes` would buy the same silence from the badge while claiming
// the route reads the facade — the exact move D321 refuses.
test("D321: chrome is never smuggled into the live-wired set", () => {
  assert.equal(isLiveWiredRoute("/app/docs"), false);
  assert.equal(isLiveWiredRoute("/app/docs/quickstart"), false);
  for (const route of liveWiredRoutes) {
    assert.equal(
      isProductChromeRoute(route),
      false,
      `${route} is registered as live-wired AND as chrome — the two classes have collided`,
    );
  }
});
