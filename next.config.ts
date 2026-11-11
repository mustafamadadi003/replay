import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  // Cloudflare quick tunnels change hostname; allow the current one for HMR.
  allowedDevOrigins: [
    "drill-reunion-locked-checking.trycloudflare.com",
    "*.trycloudflare.com",
  ],
};

export default nextConfig;
