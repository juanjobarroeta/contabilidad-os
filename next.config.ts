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
    // Sentry se carga nativo (usa hooks de require para instrumentar).
    "@sentry/node",
  ],
  // El flujo fiscal mensual ahora vive en el hub de Impuestos (/impuestos), con
  // pestañas Del mes / Historial / Anual. Las rutas antiguas redirigen a la
  // pestaña correspondiente. Next.js conserva los query params (month/year) al
  // redirigir, así que los enlaces profundos siguen funcionando. Los papeles
  // imprimibles (/impuestos/papeles) se mantienen como herramienta de detalle.
  async redirects() {
    return [
      { source: "/declaracion", destination: "/impuestos?tab=del-mes", permanent: false },
      { source: "/declaraciones", destination: "/impuestos?tab=historial", permanent: false },
      { source: "/declaracion-anual", destination: "/impuestos?tab=anual", permanent: false },
      { source: "/impuestos/detalle", destination: "/impuestos?tab=del-mes", permanent: false },
      { source: "/impuestos/cierre", destination: "/impuestos?tab=del-mes", permanent: false },
      // The Detalle view is now inlined into the unified /bancos page.
      { source: "/bancos/detalle", destination: "/bancos", permanent: false },
      // Activo fijo now lives as a tab inside the Contabilidad hub.
      { source: "/activos", destination: "/contabilidad?tab=activo-fijo", permanent: false },
      // El workspace de nómina ahora es la pestaña Corridas del hub /nomina
      // (Resumen / Corridas / Empleados / Cumplimiento). El cockpit multi-RFC
      // (/nomina/cockpit) sigue siendo página propia.
      { source: "/nomina/detalle", destination: "/nomina?tab=corridas", permanent: false },
    ];
  },
};

export default nextConfig;
