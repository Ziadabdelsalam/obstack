import type { NextConfig } from "next";
import path from "path";
import createMDX from "@next/mdx";

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
