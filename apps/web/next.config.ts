import type { NextConfig } from "next";
import { securityHeaders } from "./lib/security-headers.ts";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@sage/database", "@sage/contracts"],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  poweredByHeader: false,
  experimental: { cpus: 2 },
  async headers() {
    return [{ source: "/:path*", headers: [...securityHeaders] }];
  },
};

export default nextConfig;
