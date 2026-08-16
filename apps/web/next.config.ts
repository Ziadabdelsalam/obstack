import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  turbopack: {
    // Workspace root (single lockfile), two levels up from apps/web.
    root: path.join(__dirname, "..", ".."),
  },
};

export default nextConfig;
