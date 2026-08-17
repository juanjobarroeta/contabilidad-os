/**
 * P0-5 — Security headers (docs/security/PLAN.md). Hasta este cambio la app
 * no mandaba NINGUNO. Módulo puro (sin imports de Next) para poder probarlo
 * en la suite sin arrastrar next.config + Sentry.
 *
 * CSP va en REPORT-ONLY a propósito: el app router mete scripts inline en la
 * hidratación y el tema usa un script inline en layout.tsx — pasar a
 * enforcement requiere nonces vía middleware (tarea aparte). Report-only +
 * /api/csp-report nos da el inventario real de violaciones para escribir esa
 * política sin romper producción a ciegas. frame-ancestors NO aplica en
 * report-only, por eso X-Frame-Options: DENY va aparte y SÍ aplica hoy.
 */

/**
 * Política observacional. connect-src 'self' cubre Sentry porque el SDK del
 * navegador manda por el túnel /monitoring (mismo origen), no a ingest.
 * img-src permite https: — los logos de empresa (Company.logoUrl) pueden ser
 * URLs externas y las imágenes no son el modelo de amenaza de este paso.
 */
export const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "report-uri /api/csp-report",
].join("; ");

export const SECURITY_HEADERS: Array<{ key: string; value: string }> = [
  // Un año de HTTPS forzado por el navegador. Railway ya termina TLS; esto
  // cierra la ventana del primer request en HTTP.
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  // El navegador no adivina content-types (bloquea el sniffing de uploads).
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Nadie enmarca la app (clickjacking). Ver nota de frame-ancestors arriba.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // La app no usa cámara/micrófono/geolocalización/pago del navegador.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];
