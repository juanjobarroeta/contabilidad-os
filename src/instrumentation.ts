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
}

// Hook de Next 15: se invoca por cada error no manejado en el servidor
// (rutas de API, server components, server actions). Sin SENTRY_DSN es un
// no-op (reportError solo hace console.error).
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string }
) {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { reportError } = await import("./lib/observability");
    reportError(error, {
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
    });
  }
}
