import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@sage/database"],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  poweredByHeader: false,
  experimental: { cpus: 2 },
};

export default nextConfig;
