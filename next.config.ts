import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it external to the server bundle.
  serverExternalPackages: ["better-sqlite3", "puppeteer-core"],
  typescript: { ignoreBuildErrors: true },
  // We run one shared dev server (`next dev -H 0.0.0.0`) and reach it from phones over the
  // LAN or a Tailscale tailnet. Next 16 dev BLOCKS cross-origin requests to internal dev
  // resources (e.g. the HMR socket `/_next/webpack-hmr`) unless the host is allow-listed here.
  // When the HMR socket is blocked the dev client can't stay in sync and falls back to periodic
  // FULL PAGE RELOADS, which remount the tree and wipe in-progress form state (e.g. the "Create
  // a loop with AI" textarea clearing mid-type). Allow-listing these origins keeps HMR connected.
  //
  // These hosts are machine-specific (your Tailscale MagicDNS name, tailnet IP, .local name), so
  // set FACTORY_DEV_ORIGINS to a comma-separated list in .env.local rather than committing them.
  allowedDevOrigins: process.env.FACTORY_DEV_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
  // Allow redirecting the build output (e.g. to a roomier volume) without touching the
  // dev server's default .next. Set NEXT_DIST_DIR to an absolute or relative path.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
};

export default nextConfig;
