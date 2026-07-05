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
// Solución: un MUTEX por trabajo en una fila de la tabla `CronLock`. A
// diferencia de un advisory lock de sesión de Postgres, este candado NO depende
// de la afinidad de conexión del pool de Prisma — tomar y liberar pueden caer en
// conexiones distintas sin problema, porque el estado vive en una fila, no en la
// conexión. (El advisory lock de sesión se filtraría: `pg_advisory_unlock`
// podría ejecutarse en otra conexión del pool, no soltar el candado real y dejar
// el cron trabado en 409 indefinidamente.)
//
// Failsafe ante caídas: la toma exige que el candado esté libre O vencido. Si
// una corrida muere sin liberar, otra corrida posterior lo toma en cuanto pasa
// el TTL (TTL_CORRIDA_MS, holgadamente mayor que maxDuration), así un crash no
// deja el cron trabado para siempre.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Vida máxima de una corrida antes de considerar el candado vencido y permitir
 * que otra corrida lo tome (takeover). 10 min > maxDuration (5 min) para no
 * arrebatarle el candado a una corrida legítima aún en curso.
 */
export const TTL_CORRIDA_MS = 10 * 60 * 1000;

/**
 * Marca de "liberado": una fecha muy en el pasado. Siempre queda fuera del TTL,
 * así el candado liberado se ve como no-vigente y la próxima corrida lo toma.
 */
const LIBERADO = new Date(0);

/**
 * Deriva la clave canónica de candado a partir del nombre lógico del trabajo.
 *
 * Función PURA y determinista (sin E/S). Normaliza para que "sat-sync",
 * "  SAT-SYNC  " y "cron:sat-sync" refieran al MISMO candado, evitando que una
 * variación de mayúsculas/espacios abra una segunda corrida en paralelo.
 */
export function cronLockKey(job: string): string {
  const normalizado = job.trim().toLowerCase();
  if (normalizado.length === 0) {
    throw new Error("cronLockKey: el nombre del trabajo no puede estar vacío");
  }
  return normalizado.startsWith("cron:") ? normalizado : `cron:${normalizado}`;
}

/**
 * ¿La corrida marcada en `lockedAt` sigue vigente (dentro del TTL)?
 *
 * Función PURA y testeable — encapsula la decisión de toma/takeover:
 *   - vigente (true)  → hay otra corrida activa: se omite (409).
 *   - no vigente (false) → candado libre o vencido por un crash: se toma.
 */
export function esCorridaVigente(
  lockedAt: Date,
  now: Date,
  ttlMs: number = TTL_CORRIDA_MS
): boolean {
  return now.getTime() - lockedAt.getTime() < ttlMs;
}

/**
 * Ejecuta `fn` sólo si se logra adquirir el candado de `job`. Si otra corrida
 * vigente ya lo tiene, devuelve 409 { skipped: "already running" } sin ejecutar
 * `fn`. En cualquier caso (éxito o excepción) libera el candado en el `finally`.
 */
export async function withCronLock(
  job: string,
  fn: () => Promise<Response>
): Promise<Response> {
  const key = cronLockKey(job);
  const now = new Date();

  // Asegura que exista la fila del mutex sin perturbar un candado en curso.
  const fila = await prisma.cronLock.upsert({
    where: { job: key },
    create: { job: key, lockedAt: LIBERADO },
    update: {},
  });

  // Decisión pura de toma/takeover contra el valor leído.
  if (esCorridaVigente(fila.lockedAt, now)) {
    console.warn(`[cron-lock] ${key} ya en ejecución — se omite esta corrida`);
    return NextResponse.json({ skipped: "already running" }, { status: 409 });
  }

  // Toma atómica por compare-and-set sobre lockedAt: sólo gana quien encuentre
  // el valor exacto que leyó. Una corrida concurrente que haya tomado primero
  // cambia lockedAt y deja este WHERE sin coincidencia (count 0 → 409). El
  // bloqueo de fila del servidor serializa a los competidores.
  const { count } = await prisma.cronLock.updateMany({
    where: { job: key, lockedAt: fila.lockedAt },
    data: { lockedAt: now },
  });

  if (count !== 1) {
    console.warn(`[cron-lock] ${key} tomado por otra corrida — se omite`);
    return NextResponse.json({ skipped: "already running" }, { status: 409 });
  }

  try {
    return await fn();
  } finally {
    // Liberar: dejar lockedAt en el pasado para que la próxima corrida lo tome
    // de inmediato. Nunca debe enmascarar el resultado del trabajo; si falla, el
    // TTL termina liberándolo (failsafe).
    try {
      await prisma.cronLock.update({
        where: { job: key },
        data: { lockedAt: LIBERADO },
      });
    } catch (e) {
      console.error(`[cron-lock] no se pudo liberar ${key}:`, e);
    }
  }
}
