/**
 * Validación de variables de entorno al arranque (vía src/instrumentation.ts).
 *
 * Objetivo: que un despliegue de producción mal configurado falle en el boot,
 * de forma ruidosa y temprana, en lugar de fallar en silencio semanas después
 * (p. ej. guardar una e.firma sin cifrar porque faltaba la llave maestra).
 *
 * Reglas (solo aplican con NODE_ENV=production):
 *  - CREDENTIALS_ENCRYPTION_KEY: obligatoria y válida (32 bytes base64) → si
 *    falta, se lanza un Error y el proceso no arranca. Sin esta llave los
 *    secretos (FIEL/CSD/llaves de API) se guardarían en claro.
 *  - AUTH_SECRET / NEXTAUTH_SECRET: al menos una debe existir → Error.
 *  - CRON_SECRET ausente: advertencia (los crons fallan cerrados con 401).
 *  - SENTRY_DSN ausente: advertencia (sin monitoreo de errores).
 */

export type EnvCheckResult = {
  fatal: string[];
  warnings: string[];
};

export function checkProductionEnv(
  env: Record<string, string | undefined>
): EnvCheckResult {
  const fatal: string[] = [];
  const warnings: string[] = [];

  const rawKey = env.CREDENTIALS_ENCRYPTION_KEY;
  if (!rawKey) {
    fatal.push(
      "CREDENTIALS_ENCRYPTION_KEY no está definida. Sin ella los secretos (e.firma, CSD, llaves de API) se guardarían SIN cifrar. Genera una con: openssl rand -base64 32"
    );
  } else if (Buffer.from(rawKey, "base64").length !== 32) {
    fatal.push(
      "CREDENTIALS_ENCRYPTION_KEY es inválida: debe ser 32 bytes en base64 (genera con: openssl rand -base64 32)."
    );
  }

  if (!env.AUTH_SECRET && !env.NEXTAUTH_SECRET) {
    fatal.push(
      "Falta AUTH_SECRET (o NEXTAUTH_SECRET): las sesiones y los tokens de API no pueden firmarse."
    );
  }

  if (!env.CRON_SECRET) {
    warnings.push(
      "CRON_SECRET no está definida: los endpoints de cron responderán 401 y ninguna tarea programada se ejecutará."
    );
  }

  if (!env.SENTRY_DSN) {
    warnings.push(
      "SENTRY_DSN no está definida: los errores del servidor no se reportarán a Sentry."
    );
  }

  return { fatal, warnings };
}

/**
 * Ejecuta la validación y detiene el arranque si hay errores fatales en
 * producción. En desarrollo solo informa.
 */
export function enforceEnvAtBoot(): void {
  const isProd = process.env.NODE_ENV === "production";
  const { fatal, warnings } = checkProductionEnv(process.env);

  for (const w of warnings) {
    console.warn(`[env-check] Advertencia: ${w}`);
  }

  if (fatal.length === 0) return;

  for (const f of fatal) {
    console.error(`[env-check] ${isProd ? "FATAL" : "Faltante (fatal en producción)"}: ${f}`);
  }

  if (isProd) {
    throw new Error(
      `Configuración de producción incompleta (${fatal.length} error(es) fatal(es)); revisa las variables de entorno. Detalle en los logs de arranque.`
    );
  }
}
