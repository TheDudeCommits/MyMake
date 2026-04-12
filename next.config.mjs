import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@farcaster/mini-app-solana": path.resolve(
        process.cwd(),
        "lib/shims/farcaster-mini-app-solana.js",
      ),
      "@farcaster/miniapp-sdk": path.resolve(
        process.cwd(),
        "lib/shims/farcaster-miniapp-sdk.js",
      ),
      "@phosphor-icons/webcomponents": path.resolve(
        process.cwd(),
        "lib/shims/phosphor-webcomponents",
      ),
      "@solana/wallet-adapter-react": path.resolve(
        process.cwd(),
        "lib/shims/solana-wallet-adapter-react.js",
      ),
    };

    return config;
  },
};

export default nextConfig;
