import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Candado de ejecución única (single-flight) para los crons mutantes.
//
// Los crons son handlers HTTP planos (protegidos sólo por CRON_SECRET) que
// iteran sobre TODAS las empresas durante hasta 5 minutos (maxDuration=300). Sin
// guarda de solapamiento, una corrida lenta más el siguiente tick programado (o
// un workflow_dispatch manual) pueden procesar las mismas empresas en paralelo:
// envíos/importaciones duplicadas al SAT, notificaciones push repetidas y
// carreras en autoConciliarEmpresa.
//
// Solución: un advisory lock de sesión de Postgres. `pg_try_advisory_lock` es NO
// bloqueante — si el candado ya está tomado devuelve false y la corrida se salta
// con un 409 en vez de duplicar trabajo.
//
// IMPORTANTE: el advisory lock está atado a la CONEXIÓN de la base de datos. Se
// toma y se libera dentro de la misma petición; el `finally` garantiza la
// liberación en el camino feliz, y si la corrida se cae (el proceso muere) la
// conexión se cierra y Postgres libera el candado automáticamente — es el
// failsafe deseado, nunca queda un candado huérfano de forma permanente.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deriva la clave canónica de candado a partir del nombre lógico del trabajo.
 *
 * Función PURA y determinista (sin E/S) para poder probarla en unidad: la misma
 * entrada siempre produce la misma clave, y la clave es estable en el tiempo
 * (cambiarla soltaría el solapamiento contra corridas viejas). La clave se pasa
 * a `hashtext()` de Postgres, que la convierte en el entero de 32 bits que
 * identifica al advisory lock.
 *
 * Normaliza para que "sat-sync", "  SAT-SYNC  " y "cron:sat-sync" refieran al
 * MISMO candado, evitando que una variación de mayúsculas/espacios abra una
 * segunda corrida en paralelo por error.
 */
export function cronLockKey(job: string): string {
  const normalizado = job.trim().toLowerCase();
  if (normalizado.length === 0) {
    throw new Error("cronLockKey: el nombre del trabajo no puede estar vacío");
  }
  return normalizado.startsWith("cron:") ? normalizado : `cron:${normalizado}`;
}

/**
 * Ejecuta `fn` sólo si se logra adquirir el candado de `job`. Si otra corrida ya
 * lo tiene, devuelve 409 { skipped: "already running" } sin ejecutar `fn`. En
 * cualquier caso (éxito o excepción) libera el candado en el `finally`.
 */
export async function withCronLock(
  job: string,
  fn: () => Promise<Response>
): Promise<Response> {
  const key = cronLockKey(job);

  const filas = await prisma.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_lock(hashtext(${key})) AS locked
  `;
  const adquirido = filas[0]?.locked === true;

  if (!adquirido) {
    console.warn(`[cron-lock] ${key} ya en ejecución — se omite esta corrida`);
    return NextResponse.json({ skipped: "already running" }, { status: 409 });
  }

  try {
    return await fn();
  } finally {
    try {
      await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext(${key}))`;
    } catch (e) {
      // Liberar el candado nunca debe enmascarar el resultado del trabajo. Si la
      // liberación falla, la conexión terminará soltándolo (failsafe).
      console.error(`[cron-lock] no se pudo liberar ${key}:`, e);
    }
  }
}
