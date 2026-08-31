import type { NextConfig } from "next";
import path from "path";
import createMDX from "@next/mdx";

/**
 * D340: the marketing image renders `/signup` and `/login` as the honest
 * no-form dead end (D150) — true on a single-host build, false the moment
 * `app.obstack.dev` exists, because that IS the running product these paths
 * describe. `OBSTACK_APP_ORIGIN` unset (every build before S5, and the `web`
 * service's own build, which has no reason to redirect to itself) returns
 * `undefined` — no redirects, the dead-end pages stay; set (the marketing
 * build only) sends a stranger straight to the real form instead, at the same
 * build-time seam `appHref`/`appHost` read (D329).
 *
 * `undefined` rather than an empty array: `redirects` is an optional key
 * (node_modules/next/dist/server/config-shared.d.ts:1258,
 * `redirects?: () => Promise<Redirect[]> | Redirect[]`), and the single-host
 * build has no redirect concept, not a redirect list with nothing in it.
 *
 * Reference: node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/redirects.md
 */
function marketingRedirects(): NextConfig["redirects"] {
  const origin = process.env.OBSTACK_APP_ORIGIN?.trim() ?? "";
  if (origin === "") return undefined;
  const dest = origin.replace(/\/+$/, "");
  return () => [
    { source: "/signup", destination: `${dest}/signup`, permanent: false },
    { source: "/signup/:path*", destination: `${dest}/signup/:path*`, permanent: false },
    { source: "/login", destination: `${dest}/login`, permanent: false },
    { source: "/login/:path*", destination: `${dest}/login/:path*`, permanent: false },
  ];
}

const nextConfig: NextConfig = {
  turbopack: {
    // Workspace root (single lockfile), two levels up from apps/web.
    root: path.join(__dirname, "..", ".."),
  },
  // The MDX guide's list, verbatim
  // (node_modules/next/dist/docs/01-app/02-guides/mdx.md:61). It only widens
  // what counts as a route file under `app/`; the docs corpus lives at
  // `src/content/**` (D319 — outside `app/`, so no page of it is ever routed
  // by its filename) and is reached by import instead.
  pageExtensions: ["js", "jsx", "md", "mdx", "ts", "tsx"],
  // Traces only the files each page needs into `.next/standalone` (D251(a));
  // the Dockerfile copies that folder instead of `node_modules` + source.
  // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md
  output: "standalone",
  redirects: marketingRedirects(),
};

/**
 * D319's two plugins, in the STRING form
 * (`mdx.md:728-760` — "Using Plugins with Turbopack"): this repo builds with
 * Turbopack, and the guide's note at `:760` is explicit that a plugin passed
 * as an imported function cannot cross into Rust. Naming them as strings with
 * serializable options is the only form that works here, and it also keeps
 * this file free of the ESM-only import the non-Turbopack recipe needs
 * (`mdx.md:701`).
 *
 * - `remark-gfm`: tables, strikethrough, task lists, autolinks.
 * - `rehype-slug`: an `id` on every heading, so a docs page can be linked to
 *   at a section. Measured: an override in `src/mdx-components.tsx` that does
 *   not spread `...props` silently drops that id (NX3), which is why every
 *   override there spreads and a test asserts it.
 */
const withMDX = createMDX({
  options: {
    remarkPlugins: [["remark-gfm"]],
    rehypePlugins: [["rehype-slug"]],
  },
});

export default withMDX(nextConfig);
