import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  // P0-5: headers de seguridad en TODA respuesta (páginas y API). La lista
  // vive en src/lib/security-headers.ts (módulo puro, con test); quitarle un
  // header pone la suite en rojo antes de llegar al deploy.
  async headers() {
    return [{ source: "/(.*)", headers: SECURITY_HEADERS }];
  },
  // El release del navegador tiene que ser EL MISMO que el del servidor para
  // que un error de React y la excepción que lo causó caigan en el mismo
  // deploy. Railway expone el SHA; aquí lo horneamos al bundle del cliente.
  ...(process.env.RAILWAY_GIT_COMMIT_SHA
    ? { env: { NEXT_PUBLIC_SENTRY_RELEASE: process.env.RAILWAY_GIT_COMMIT_SHA } }
    : {}),
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
    // qpdf (WASM) desencripta estados de cuenta con contraseña: carga su .wasm
    // desde node_modules en runtime, no debe pasar por webpack.
    "@jspawn/qpdf-wasm",
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

// withSentryConfig envuelve la config para: (a) subir los source maps al
// build, sin los cuales un stack trace de producción es una sopa de letras
// minificada; (b) instrumentar el server bundle; (c) crear el "túnel".
//
// Todo esto es OPCIONAL en el sentido correcto: sin SENTRY_AUTH_TOKEN el build
// NO falla, solo se salta la subida de source maps. Así un clon del repo sin
// credenciales de Sentry sigue compilando.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG ?? "cumplo-id",
  project: process.env.SENTRY_PROJECT ?? "contabilidad-os",
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Silencioso en local; ruidoso en CI, donde sí queremos ver si la subida falló.
  silent: !process.env.CI,

  sourcemaps: {
    // Sin token no hay a dónde subirlos: apagar explícitamente evita el
    // warning ruidoso en cada build local.
    disable: !process.env.SENTRY_AUTH_TOKEN,
    // No dejar los .map servidos públicamente después de subirlos a Sentry:
    // exponen el código fuente del producto a cualquiera.
    deleteSourcemapsAfterUpload: true,
  },

  // Cubre también los chunks fuera de /_next/static, para que los stack traces
  // de código en workers y rutas dinámicas también se desminifiquen.
  widenClientFileUpload: true,

  // Los bloqueadores de anuncios tiran las peticiones a ingest.sentry.io, y con
  // ellas una parte nada despreciable de los errores del navegador. El túnel
  // las manda a nuestro propio dominio y de ahí a Sentry. La ruta /monitoring
  // no la toca el matcher del middleware, así que no necesita CORS ni auth.
  tunnelRoute: "/monitoring",

  webpack: {
    treeshake: {
      // Quita el logger de debug del SDK del bundle de producción.
      removeDebugLogging: true,
    },
    // No estamos en Vercel (esto corre en Railway): no crear cron monitors ahí.
    automaticVercelMonitors: false,
  },
});
