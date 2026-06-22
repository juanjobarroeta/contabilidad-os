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
  // The monthly tax flow now lives in the Declaración Workspace (/declaracion).
  // The old summary and cierre pages are superseded by its Resumen/Presentar
  // tabs, so they redirect in. The advanced calc (/impuestos/detalle) and the
  // printable papeles (/impuestos/papeles) stay as depth tools, linked from the
  // workspace.
  async redirects() {
    return [
      { source: "/impuestos", destination: "/declaracion", permanent: false },
      { source: "/impuestos/cierre", destination: "/declaracion?tab=presentar", permanent: false },
      // The Detalle view is now inlined into the unified /bancos page.
      { source: "/bancos/detalle", destination: "/bancos", permanent: false },
    ];
  },
};

export default nextConfig;
