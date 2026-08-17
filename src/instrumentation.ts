// Next.js instrumentation: runs once at server startup.
//
// IMPORTANTE: este archivo se compila también para el runtime edge. Los
// imports dinámicos deben ir DENTRO de un bloque
// `if (process.env.NEXT_RUNTIME === "nodejs")` — Next sustituye NEXT_RUNTIME
// por un literal en build y webpack elimina la rama muerta, de modo que
// @sentry/node (que usa node:child_process, etc.) nunca se resuelve en el
// bundle edge. Un early-return NO basta: webpack igual resuelve los imports.
//
// 1) Polyfill de `File`: Node < 20 no expone `File` como global, pero
//    `Request.formData()` de undici construye instancias de `File` para las
//    partes multipart — sin el global lanza "File is not defined", rompiendo
//    todas las rutas de subida de PDF/CSV. Node 18 trae `File` en
//    `node:buffer` (desde 18.13) pero no como global, así que lo subimos a
//    globalThis. En Node ≥20 es un no-op.
// 2) Validación de entorno: en producción, una configuración incompleta
//    (p. ej. sin CREDENTIALS_ENCRYPTION_KEY) detiene el arranque en vez de
//    fallar en silencio semanas después. Ver src/lib/env-check.ts.
// 3) Sentry: si SENTRY_DSN está definida, inicializa el reporte de errores
//    del servidor; `onRequestError` captura los errores no manejados de
//    rutas/render. Ver src/lib/observability.ts.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const g = globalThis as { File?: unknown; Blob?: unknown };
    if (typeof g.File === "undefined") {
      const buffer = await import("node:buffer");
      if (buffer.File) g.File = buffer.File;
      if (typeof g.Blob === "undefined" && buffer.Blob) g.Blob = buffer.Blob;
    }

    const { enforceEnvAtBoot } = await import("./lib/env-check");
    enforceEnvAtBoot();

    const { initObservability } = await import("./lib/observability");
    initObservability();

    // 4) Pipeline de datos en-proceso: agenda los crons de backfill/sync SAT y
    //    Syntage dentro del servidor (Railway siempre encendido), para que el
    //    producto no dependa de GitHub Actions. Ver src/lib/cron-scheduler.ts.
    const { startInAppCron } = await import("./lib/cron-scheduler");
    startInAppCron();
  }

  // 5) Runtime EDGE (src/middleware.ts). Hasta ahora corría sin instrumentar:
  //    todo error del middleware —el que decide auth y redirecciones, o sea el
  //    que puede dejar fuera a TODOS los usuarios— moría en logs efímeros.
  //    Aquí no va env-check ni cron: el edge no tiene acceso a esas APIs.
  if (process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs");
    const shared = await import("./lib/sentry-shared");
    const dsn = process.env.SENTRY_DSN;
    if (dsn) {
      Sentry.init({
        dsn,
        environment: shared.sentryEnvironment(),
        release: shared.sentryRelease(),
        tracesSampleRate: shared.tracesSampleRate(),
        sendDefaultPii: false,
        ignoreErrors: shared.IGNORED_ERRORS,
        beforeSend: (event) => shared.scrubEvent(event),
        beforeSendTransaction: (event) => shared.scrubEvent(event),
      });
    }
  }
}

// Hook de Next 15: se invoca por cada error no manejado en el servidor
// (rutas de API, server components, server actions) en cualquier runtime.
//
// `captureRequestError` del SDK de Next es lo correcto aquí (y no un
// captureException a mano): adjunta el contexto de la petición y —lo que
// importa para depurar entre proyectos— reconstruye la traza que venía en los
// headers, de modo que este error queda colgado de la MISMA traza que originó
// el click en el satélite Automotriz.
//
// Sin SENTRY_DSN, Sentry.init nunca corrió y esto es un no-op.
export async function onRequestError(
  ...args: Parameters<typeof import("@sentry/nextjs").captureRequestError>
) {
  const { captureRequestError } = await import("@sentry/nextjs");
  captureRequestError(...args);
}
