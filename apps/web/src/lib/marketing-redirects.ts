import type { NextConfig } from "next";

type Redirect = NonNullable<Awaited<ReturnType<NonNullable<NextConfig["redirects"]>>>>[number];

/**
 * D340/D354 (C-1 low finding): the marketing image renders `/signup` and
 * `/login` as the honest no-form dead end (D150) — true on a single-host
 * build, false the moment the configured app origin exists, because that IS
 * the running product these paths describe.
 *
 * Gated on BOTH `OBSTACK_DATA_MODE === "mock"` and an origin, not the origin
 * alone (the low finding this fixes): the redirect makes sense only on the
 * marketing build's own dead-end pages. The `web` (live) service never sets
 * `OBSTACK_APP_ORIGIN` today (§Topology), but if some future config carried
 * one there anyway, `/signup` and `/login` on that image are the REAL forms
 * — redirecting a live visitor away from them would be the D340 flip
 * un-flipping itself on the one build where it must not.
 *
 * A standalone, directly-testable function (D354) rather than inlined in
 * `next.config.ts`: that file's other config (Turbopack root, MDX plugins)
 * is only meaningfully exercised through `next build`'s config loader, and
 * this needs no part of it — it reads two env vars and returns data.
 *
 * Always returns an array, never `undefined`: an empty list is exactly "no
 * redirects" to `next.config.ts`'s `redirects()` key, and the single-host
 * and live-mode arms both mean that.
 *
 * Reference: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/redirects.md
 */
export function marketingRedirects(): Redirect[] {
  if (process.env.OBSTACK_DATA_MODE !== "mock") return [];
  const origin = process.env.OBSTACK_APP_ORIGIN?.trim() ?? "";
  if (origin === "") return [];
  const dest = origin.replace(/\/+$/, "");
  return [
    { source: "/signup", destination: `${dest}/signup`, permanent: false },
    { source: "/signup/:path*", destination: `${dest}/signup/:path*`, permanent: false },
    { source: "/login", destination: `${dest}/login`, permanent: false },
    { source: "/login/:path*", destination: `${dest}/login/:path*`, permanent: false },
  ];
}
