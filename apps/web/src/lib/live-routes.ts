/**
 * Which app routes read real data in live mode (D21).
 *
 * Pure data plus a pure predicate, deliberately outside `src/server/` so the
 * shell can use it from a client component without dragging the query layer in.
 * Routes not listed here still render mock content and get the
 * "SAMPLE DATA — preview" badge, so wiring a new surface is one line.
 *
 * An entry ending in "/" matches its whole subtree; any other entry is exact.
 */
export const liveWiredRoutes: readonly string[] = [
  "/app", // overview
  "/app/traces", // traces list
  "/app/traces/", // trace detail
  "/app/logs", // logs explorer
  "/app/onboarding", // quickstart: the workspace's own key, its real arrival signal
  "/app/connections", // connected sources with their D100 ingest health
  "/app/explore", // ad-hoc metric queries through T6's frozen contract (D363)
  "/app/dashboards", // the workspace's own dashboard rows, from Postgres (D424)
  "/app/dashboards/", // and one of them, its widgets read through that same contract
  "/app/map", // service topology derived from the workspace's own spans
  "/app/services", // the trace-derived catalog
  "/app/services/", // and one service's scorecard, under the same derivation
  "/app/users", // impacted users, keyed by enduser.id / user.id on root spans
  "/app/issues", // error spans grouped by fingerprint
  "/app/infra", // the workspace's own nodes and pods, from the collector's k8s metrics
  "/app/costs", // LLM unit economics derived from this workspace's own llm spans
  "/app/alerts", // the workspace's own rules, evaluated events and channels (S7.1)
  "/app/changes", // the workspace's own change events, posted by its systems to /v1/changes (S7.2)
  "/app/slos", // the workspace's own objectives, measured over its traces by the evaluator (S7.3)
  // Settings is wired per SECTION, not per route (D106): General, Members and
  // API keys read Postgres, and the four tabs that still render demo content
  // carry their own `SampleMark` inside the suite. One route-wide badge over a
  // page whose first three tabs are real would be the inverse lie of the one it
  // exists to prevent.
  "/app/settings",
];

// The carve-out list is GONE with its last entry (S6.2): `/app/traces/diff` was
// the one route excluded from a wired prefix, and it now reads two of the
// workspace's own traces (D400), so nothing is carved out of anything. An empty
// exclusion list consulted on every call is a branch that can only ever say
// "no" — the next route that needs one brings it back with its reason.
export function isLiveWiredRoute(pathname: string): boolean {
  return liveWiredRoutes.some((route) =>
    route.endsWith("/") ? pathname.startsWith(route) : pathname === route,
  );
}

/**
 * PRODUCT CHROME (D321) — the third class, beside "live-wired" and "not yet
 * wired".
 *
 * D21 split `/app/*` in two: a route either reads the workspace's real data in
 * live mode, or it renders sample content and says so. `/app/docs` is neither.
 * It reads no workspace data in either mode, and what it renders is TRUE in
 * both — the same MDX corpus the public `/docs` serves, byte for byte, out of
 * the same build.
 *
 * Both existing labels are therefore lies about it, in opposite directions:
 * adding it to `liveWiredRoutes` would claim it reads the facade, and leaving
 * it out puts "SAMPLE DATA — preview" over a real self-hosting instruction in
 * live mode and "every screen here is sample data from a fictional company"
 * under it in mock mode — the second one on the public demo host, where the
 * docs are the thing a stranger came to read.
 *
 * So chrome is named as its own class and consumed by the three surfaces that
 * label routes: `SampleDataBadge` (renders nothing), `CommandPalette.hintFor`
 * (hint "docs", never "sample data"), and `DemoFooter` (renders nothing).
 * `liveWiredRoutes` above is untouched — chrome is never smuggled into the
 * live set to buy silence.
 *
 * Same matching rule as `liveWiredRoutes`: an entry ending in "/" matches its
 * whole subtree, any other entry is exact. `/app/docs` is both, because the
 * mount owns its own base path and every page under it.
 */
export const productChromeRoutes: readonly string[] = [
  "/app/docs", // the docs mount — the public /docs corpus inside the shell
  "/app/docs/",
];

export function isProductChromeRoute(pathname: string): boolean {
  return productChromeRoutes.some((route) =>
    route.endsWith("/") ? pathname.startsWith(route) : pathname === route,
  );
}
