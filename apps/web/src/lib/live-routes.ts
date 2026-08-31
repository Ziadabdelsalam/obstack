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
  // Settings is wired per SECTION, not per route (D106): General, Members and
  // API keys read Postgres, and the four tabs that still render demo content
  // carry their own `SampleMark` inside the suite. One route-wide badge over a
  // page whose first three tabs are real would be the inverse lie of the one it
  // exists to prevent.
  "/app/settings",
];

/**
 * Routes carved back out of a wired prefix because they are still pure mock —
 * `/app/traces/diff` is an M5 surface living under the wired trace-detail
 * subtree, so it keeps the badge in live mode.
 */
export const liveWiredRouteExclusions: readonly string[] = ["/app/traces/diff"];

export function isLiveWiredRoute(pathname: string): boolean {
  if (liveWiredRouteExclusions.includes(pathname)) return false;
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
