// Next.js instrumentation: runs once at server startup.
//
// 1) Polyfill de `File`: Node < 20 no expone `File` como global, pero
//    `Request.formData()` de undici construye instancias de `File` para las
//    partes multipart — sin el global lanza "File is not defined" y rompe
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
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
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
}

// Hook de Next 15: se invoca por cada error no manejado en el servidor
// (rutas de API, server components, server actions). Sin SENTRY_DSN es un
// no-op (reportError solo hace console.error).
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string }
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportError } = await import("./lib/observability");
  reportError(error, {
    path: request.path,
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
  });
}
