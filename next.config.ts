import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000", "contabilidad-os-production.up.railway.app"],
    },
  },
};

export default nextConfig;
