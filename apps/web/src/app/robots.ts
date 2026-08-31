import type { MetadataRoute } from "next";

/**
 * D340(f): the live app is a signed-in product — nothing behind `/app` is
 * public, and there is no reason for a crawler to index a workspace it cannot
 * open. The mock image IS the public marketing/demo surface (D262) and stays
 * open to every agent.
 *
 * The gate is the same `OBSTACK_DATA_MODE` build input every other mode
 * branch in this app reads (`server/data.ts`), but read directly here rather
 * than through that facade: `dataMode`'s `resolveMode()` throws in `live` mode
 * without `CLICKHOUSE_URL`, which this route has no reason to require just to
 * answer a crawler. DEFAULT-DENY instead: only the literal `"mock"` allows —
 * unset, `"live"`, or anything unrecognised disallows, so a broken or
 * misconfigured build never accidentally opens a live deployment to indexing.
 *
 * Reference: node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/robots.md
 */
export default function robots(): MetadataRoute.Robots {
  const isMock = process.env.OBSTACK_DATA_MODE === "mock";
  return {
    rules: {
      userAgent: "*",
      ...(isMock ? { allow: "/" } : { disallow: "/" }),
    },
  };
}
