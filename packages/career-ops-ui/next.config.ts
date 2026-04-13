import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  outputFileTracingRoot: path.join(__dirname, "..", ".."),
  experimental: {
    proxyTimeout: 60 * 60 * 1000,
  },
};

export default nextConfig;
