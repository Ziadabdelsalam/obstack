import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    // Workspace root (single lockfile), two levels up from apps/web.
    root: path.join(__dirname, "..", ".."),
  },
  // Traces only the files each page needs into `.next/standalone` (D251(a));
  // the Dockerfile copies that folder instead of `node_modules` + source.
  // node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md
  output: "standalone",
};

export default nextConfig;
