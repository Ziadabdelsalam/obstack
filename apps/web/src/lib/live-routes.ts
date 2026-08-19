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
