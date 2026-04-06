import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000", "contabilidad-os-production.up.railway.app"],
    },
  },
  // Do NOT bundle these SAT/crypto packages — load them natively via Node.js
  // to avoid webpack stripping prototype methods off node-forge BigInteger objects
  serverExternalPackages: [
    "@nodecfdi/sat-ws-descarga-masiva",
    "@nodecfdi/credentials",
    "@nodecfdi/cfdi-core",
    "@nodecfdi/rfc",
    "node-forge",
    "luxon",
    "jszip",
    "pdf-parse",
  ],
};

export default nextConfig;
