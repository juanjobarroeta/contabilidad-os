/**
 * Observabilidad de errores del servidor (Sentry).
 *
 * - Se inicializa una sola vez desde src/instrumentation.ts si SENTRY_DSN está
 *   definida; sin DSN todo es un no-op silencioso (console únicamente).
 * - `reportError` es el punto único para reportar errores capturados a mano
 *   (p. ej. los errores por-empresa que los crons acumulan en `errors[]` y que
 *   hoy mueren en logs efímeros). Úsalo en los catch de pipelines.
 *
 * Nunca pases secretos (llaves, contraseñas, tokens) en `context`.
 */

import * as Sentry from "@sentry/node";

let initialized = false;

export function initObservability(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || initialized) return;
  Sentry.init({
    dsn,
    environment:
      process.env.RAILWAY_ENVIRONMENT_NAME ?? process.env.NODE_ENV ?? "development",
    // Solo errores por ahora; sin tracing para no agregar costo/latencia.
    tracesSampleRate: 0,
  });
  initialized = true;
  console.log("[observability] Sentry inicializado");
}

export function observabilityEnabled(): boolean {
  return initialized;
}

/**
 * Reporta un error a Sentry (si está configurado) y siempre a console.error.
 * `context` se adjunta como datos extra del evento (tags planos + extras).
 */
export function reportError(
  error: unknown,
  context?: Record<string, string | number | boolean | null | undefined>
): void {
  console.error("[reportError]", error, context ?? "");
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        if (v === undefined) continue;
        // Tags cortos para poder filtrar; todo también como extra.
        if (typeof v === "string" && v.length <= 64) scope.setTag(k, v);
        scope.setExtra(k, v);
      }
    }
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error))
    );
  });
}

/** Exposición interna para el hook onRequestError de Next. */
export { Sentry };
