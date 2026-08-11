// ─────────────────────────────────────────────────────────────────────────────
// Progreso durable de los drenados históricos (carga inicial del onboarding).
//
// Los backfills que barren TODO el archivo de CFDIs (refacciones, servicio) no
// caben en una corrida: llevan cursor. Si ese cursor vive en la consola de
// quien opera, la carga inicial depende de una persona — justo lo contrario de
// «solo corre». Aquí el cursor vive en la base: el scheduler retoma donde se
// quedó, sobrevive redeploys y la pantalla puede mostrar el avance.
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from "@prisma/client";

export type BackfillJob = "refacciones" | "servicio";

export interface ProgresoActual {
  cursor: string | null;
  procesados: number;
  derivados: number;
  completado: boolean;
}

/** Progreso guardado de un job para una empresa (crea la fila si no existe). */
export async function leerProgreso(
  db: PrismaClient,
  companyId: string,
  job: BackfillJob
): Promise<ProgresoActual> {
  const row = await db.backfillProgreso.findUnique({
    where: { companyId_job: { companyId, job } },
    select: { cursor: true, procesados: true, derivados: true, completadoAt: true },
  });
  return {
    cursor: row?.cursor ?? null,
    procesados: row?.procesados ?? 0,
    derivados: row?.derivados ?? 0,
    completado: row?.completadoAt != null,
  };
}

/**
 * Guarda el avance de una corrida. `completado` marca el fin del barrido: el
 * cursor se conserva (auditoría) y el job deja de elegirse como pendiente.
 */
export async function guardarProgreso(
  db: PrismaClient,
  companyId: string,
  job: BackfillJob,
  datos: { cursor: string | null; procesados: number; derivados: number; completado: boolean }
): Promise<void> {
  const comun = {
    cursor: datos.cursor,
    completadoAt: datos.completado ? new Date() : null,
  };
  await db.backfillProgreso.upsert({
    where: { companyId_job: { companyId, job } },
    create: {
      companyId,
      job,
      ...comun,
      procesados: datos.procesados,
      derivados: datos.derivados,
    },
    update: {
      ...comun,
      procesados: { increment: datos.procesados },
      derivados: { increment: datos.derivados },
    },
  });
}

/**
 * Empresas con el módulo AUTOMOTRIZ cuya carga inicial de `job` sigue abierta,
 * más antiguas primero (la que lleva más tiempo esperando avanza antes).
 */
export async function empresasPendientes(
  db: PrismaClient,
  job: BackfillJob,
  limite = 5
): Promise<string[]> {
  const companies = await db.company.findMany({
    where: {
      modules: { some: { modulo: "AUTOMOTRIZ", habilitado: true } },
      OR: [
        { backfillProgreso: { none: { job } } },
        { backfillProgreso: { some: { job, completadoAt: null } } },
      ],
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
    take: limite,
  });
  return companies.map((c) => c.id);
}

/** Reinicia el barrido (p. ej. tras cambiar las reglas de extracción). */
export async function reiniciarProgreso(
  db: PrismaClient,
  companyId: string,
  job: BackfillJob
): Promise<void> {
  await db.backfillProgreso.upsert({
    where: { companyId_job: { companyId, job } },
    create: { companyId, job },
    update: { cursor: null, procesados: 0, derivados: 0, completadoAt: null },
  });
}
