/**
 * Observabilidad de errores del SERVIDOR (Sentry, runtime Node).
 *
 * - Se inicializa una sola vez desde src/instrumentation.ts si SENTRY_DSN está
 *   definida; sin DSN todo es un no-op silencioso (console únicamente).
 * - `reportError` es el punto único para reportar errores capturados a mano
 *   (p. ej. los errores por-empresa que los crons acumulan en `errors[]` y que
 *   hoy mueren en logs efímeros). Úsalo en los catch de pipelines.
 *
 * El navegador se inicializa aparte en src/instrumentation-client.ts y el
 * runtime edge (middleware) en src/instrumentation.ts; los tres comparten
 * ambiente, release, muestreo y filtrado vía src/lib/sentry-shared.ts.
 *
 * Nunca pases secretos (llaves, contraseñas, tokens) en `context`. Aun así,
 * `scrubEvent` filtra por nombre de clave como última barrera.
 */

import * as Sentry from "@sentry/nextjs";
import {
  IGNORED_ERRORS,
  scrubEvent,
  sentryEnvironment,
  sentryRelease,
  tracesSampleRate,
} from "./sentry-shared";

let initialized = false;

export function initObservability(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || initialized) return;
  Sentry.init({
    dsn,
    environment: sentryEnvironment(),
    release: sentryRelease(),
    // Las trazas son lo que une un click en el satélite Automotriz con la
    // excepción que ocurre aquí. Ver tracesSampleRate() para el default.
    tracesSampleRate: tracesSampleRate(),
    // Datos fiscales: jamás mandar PII por default (IPs, cookies, cuerpos).
    sendDefaultPii: false,
    ignoreErrors: IGNORED_ERRORS,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
  initialized = true;
  console.log(
    `[observability] Sentry inicializado (env=${sentryEnvironment()}, release=${
      sentryRelease() ?? "sin-release"
    }, traces=${tracesSampleRate()})`
  );
}

export function observabilityEnabled(): boolean {
  return initialized;
}

/**
 * Reporta un error a Sentry (si está configurado) y siempre a console.error.
 * `context` se adjunta como datos extra del evento (tags planos + extras).
 *
 * `options.tags` permite agrupar a mano: pasa `{ pipeline: "sat-sync" }` para
 * poder filtrar y alertar por pipeline en Sentry.
 */
export function reportError(
  error: unknown,
  context?: Record<string, string | number | boolean | null | undefined>,
  options?: { level?: "fatal" | "error" | "warning" | "info"; fingerprint?: string[] }
): void {
  console.error("[reportError]", error, context ?? "");
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (options?.level) scope.setLevel(options.level);
    if (options?.fingerprint) scope.setFingerprint(options.fingerprint);
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

/**
 * Envuelve un job de fondo (cron, backfill) para que CUALQUIER excepción llegue
 * a Sentry etiquetada con el nombre del job, y se re-lance para que el llamador
 * decida. Pensado para los catch de src/lib/cron-scheduler.ts y scripts/.
 *
 *   await withJobReporting("sat-sync", () => syncSat(companyId), { companyId })
 */
export async function withJobReporting<T>(
  jobName: string,
  fn: () => Promise<T>,
  context?: Record<string, string | number | boolean | null | undefined>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    reportError(error, { ...context, job: jobName }, { fingerprint: ["job", jobName] });
    throw error;
  }
}

/**
 * Vacía la cola de eventos antes de que el proceso muera. Los scripts de
 * `scripts/` y los cron de GitHub Actions terminan con process.exit, que se
 * lleva por delante los eventos que Sentry aún no ha subido.
 */
export async function flushObservability(timeoutMs = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.flush(timeoutMs);
  } catch {
    /* no dejar que el flush tumbe el proceso */
  }
}

/** Exposición interna para el hook onRequestError de Next. */
export { Sentry };
