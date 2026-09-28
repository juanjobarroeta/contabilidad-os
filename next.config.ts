import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            // Navigation/framing baseline, NOT a script/XSS allowlist. A strict
            // script-src needs a separately tested nonce rollout for Next's
            // inline hydration and our theme bootstrap. Same-origin frames
            // preserve the in-app PDF viewers; satellite API fetches use CORS.
            value: "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'",
          },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            // The hub does not use these capabilities. This does not restrict
            // the separate satellite documents that fetch our bearer APIs.
            // Leave web-share enabled for the installed-PWA PDF download flow.
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      ...(process.env.NODE_ENV === "production"
        ? [{
            source: "/:path*",
            // Railway terminates TLS and supplies this header. Do not send
            // HSTS on plain HTTP/local development or opt other hosts into
            // includeSubDomains/preload without a separate domain audit.
            has: [{ type: "header" as const, key: "x-forwarded-proto", value: "https" }],
            headers: [{ key: "Strict-Transport-Security", value: "max-age=31536000" }],
          }]
        : []),
    ];
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
  // Legacy workspace redirects live in middleware: Next 15's config-redirect
  // response drops previously matched headers(), including the security baseline.
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
