/**
 * Configuración COMPARTIDA de Sentry entre los tres runtimes (node, edge,
 * navegador). Vive aparte a propósito: este archivo se importa también desde
 * `src/instrumentation-client.ts`, que se compila para el navegador, así que
 * NO puede importar nada de Node (`node:*`, prisma, etc.) ni leer variables de
 * entorno privadas — solo las `NEXT_PUBLIC_*` llegan al bundle del cliente.
 *
 * Lo que se centraliza aquí:
 *  - `environment` y `release` (para que un error del navegador y su excepción
 *    del servidor caigan en el mismo release y se puedan resolver juntos).
 *  - El muestreo de trazas, ajustable por variable de entorno sin redesplegar
 *    código.
 *  - `scrubEvent`: el filtro de datos sensibles. ESTE PRODUCTO MANEJA e.firma,
 *    CSD, contraseñas del SAT y RFCs — nada de eso puede salir hacia Sentry.
 */

/** Nombre del ambiente: Railway lo inyecta; en local cae a NODE_ENV. */
export function sentryEnvironment(): string {
  return (
    process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
    process.env.RAILWAY_ENVIRONMENT_NAME ??
    process.env.NODE_ENV ??
    "development"
  );
}

/**
 * Release = SHA del commit desplegado. Railway lo expone como
 * RAILWAY_GIT_COMMIT_SHA; el build de Next lo copia a NEXT_PUBLIC_* (ver
 * next.config.ts) para que el navegador reporte el MISMO release que el
 * servidor. Sin release, Sentry no puede aplicar source maps ni decir
 * "esto se rompió en el deploy de ayer".
 */
export function sentryRelease(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SENTRY_RELEASE ??
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    undefined
  );
}

/**
 * Muestreo de trazas. Las trazas son lo que conecta un click en el satélite
 * Automotriz con la excepción que ocurrió aquí en el hub, así que no puede ser
 * 0 si queremos depurar "entre proyectos". Pero tampoco 1.0: cada traza
 * consume cuota.
 *
 * Default: 10% en producción, 0 en desarrollo. Ajustable con
 * SENTRY_TRACES_SAMPLE_RATE (servidor) o NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
 * (navegador) sin tocar código.
 */
export function tracesSampleRate(): number {
  const raw =
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ??
    process.env.SENTRY_TRACES_SAMPLE_RATE;
  if (raw !== undefined) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return sentryEnvironment() === "development" ? 0 : 0.1;
}

/**
 * Claves cuyo VALOR nunca debe viajar a Sentry. Se comparan en minúsculas y
 * por inclusión, así que "csdPassword", "fiel_key" y "authorization" caen
 * todas. Ampliar esta lista es más barato que una fuga.
 */
const SENSITIVE_KEY_PATTERNS = [
  "password",
  "contrasena",
  "contraseña",
  "secret",
  "token",
  "authorization",
  "cookie",
  "apikey",
  "api_key",
  "privatekey",
  "private_key",
  "csd",
  "fiel",
  "efirma",
  "e_firma",
  "cer",
  "key",
  "dsn",
  "credential",
];

const REDACTED = "[Filtrado]";

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Recorre un objeto y reemplaza por `[Filtrado]` el valor de toda clave
 * sensible. Se limita la profundidad para no morir en estructuras cíclicas
 * grandes (los eventos de Sentry son planos en la práctica).
 */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/**
 * `beforeSend` / `beforeSendTransaction`: última barrera antes de que un evento
 * salga del proceso. Quita headers y datos de request sensibles, y filtra
 * cualquier extra/tag con nombre comprometedor.
 */
export function scrubEvent<T extends object>(event: T): T {
  // Se muta en sitio y se devuelve el MISMO objeto: así el tipo concreto que
  // espera Sentry (ErrorEvent / TransactionEvent) se conserva intacto.
  const e = event as Record<string, unknown>;

  const request = e.request as Record<string, unknown> | undefined;
  if (request) {
    if (request.headers) request.headers = redact(request.headers, 1);
    if (request.cookies) request.cookies = REDACTED;
    if (request.data) request.data = redact(request.data, 1);
    // La query string puede traer tokens en enlaces mal hechos.
    if (typeof request.query_string === "string") {
      request.query_string = REDACTED;
    }
  }

  if (e.extra) e.extra = redact(e.extra, 1);
  if (e.contexts) e.contexts = redact(e.contexts, 1);

  const tags = e.tags as Record<string, unknown> | undefined;
  if (tags) {
    for (const k of Object.keys(tags)) {
      if (isSensitiveKey(k)) tags[k] = REDACTED;
    }
  }

  return event;
}

/**
 * Ruido conocido que no vale la cuota ni la atención: extensiones del
 * navegador, cancelaciones de red del propio usuario y fallos de chunk que se
 * resuelven solos al recargar tras un deploy.
 */
export const IGNORED_ERRORS: (string | RegExp)[] = [
  "ResizeObserver loop limit exceeded",
  "ResizeObserver loop completed with undelivered notifications",
  /^AbortError/,
  /Failed to fetch/i,
  /NetworkError when attempting to fetch/i,
  /Load failed/i,
  // Chunk viejo pedido por una pestaña abierta durante un deploy.
  /Loading chunk .* failed/i,
  /ChunkLoadError/,
  // Extensiones del navegador inyectando código.
  /^chrome-extension:/,
  /^moz-extension:/,
];
