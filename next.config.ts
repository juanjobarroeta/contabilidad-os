import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000", "contabilidad-os-production.up.railway.app"],
    },
  },
  transpilePackages: [
    "@nodecfdi/sat-ws-descarga-masiva",
    "@nodecfdi/credentials",
    "@nodecfdi/cfdi-core",
    "@nodecfdi/rfc",
  ],
};

export default nextConfig;
