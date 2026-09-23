// ─────────────────────────────────────────────────────────────────────────────
// CFDI SUSTITUIDOS (TipoRelacion 04).
//
// Cuando un emisor corrige un CFDI emite otro que lo «sustituye» (relación 04)
// y debería cancelar el original. Muchos no lo cancelan, o el SAT tarda: el
// original sigue VIGENTE, nuestra fila sigue STAMPED y contaba junto con su
// reemplazo. En REPs eso es IVA acreditado dos veces por el mismo pago (CENTRO,
// ago-2026: 7,440 de más en una sola factura de 26,680).
//
// Aquí se marca el original con `sustituidoPorUuid` = el UUID del sustituto.
// Lo que filtra es rep-vigente.ts (REP_VIGENTE). Si el sustituto se cancela, la
// marca se limpia: el original vuelve a contar.
//
// Tres entradas: al importar un CFDI (que puede ser el sustituto o el
// sustituido, llegan en cualquier orden), al cancelarse uno, y el cron
// cfdi-sustitucion-backfill para lo que ya estaba en la base.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { normalizarUuid, variantesUuid } from "./fiscal/uuid";

type Db = PrismaClient | Prisma.TransactionClient;

export type Relacionados = Array<{ tipoRelacion: string; uuids: string[] }>;

/** Los UUIDs que un CFDI dice sustituir (relación 04), sin él mismo. PURO. */
export function sustituidosDe(relacionados: Relacionados, uuidPropio: string): string[] {
  const propio = normalizarUuid(uuidPropio);
  const out = new Set<string>();
  for (const r of relacionados) {
    if (r.tipoRelacion.trim() !== "04") continue;
    for (const u of r.uuids) {
      const n = normalizarUuid(u);
      if (n && n !== propio) out.add(n);
    }
  }
  return [...out];
}

/** Marcados por TipoDeComprobante del SAT (I/E/P/N/T; «?» si no se sabe). */
export type ConteoPorTipo = Record<string, number>;

/**
 * El CFDI `sustituto` (ya STAMPED) marca a los que sustituye, de la MISMA
 * empresa, que sigan timbrados. Idempotente: lo ya marcado por él no se toca.
 */
export async function marcarSustituidos(
  db: Db,
  companyId: string,
  sustituto: { uuid: string; relacionados: Relacionados },
): Promise<ConteoPorTipo> {
  const objetivos = sustituidosDe(sustituto.relacionados, sustituto.uuid);
  if (objetivos.length === 0) return {};
  const marca = normalizarUuid(sustituto.uuid);
  const filas = await db.invoice.findMany({
    where: {
      companyId,
      uuid: { in: variantesUuid(objetivos) },
      status: "STAMPED",
      // `NOT { campo: x }` deja fuera los null en SQL: por eso el OR explícito.
      OR: [{ sustituidoPorUuid: null }, { sustituidoPorUuid: { not: marca } }],
    },
    select: { id: true, tipoSat: true },
  });
  if (filas.length === 0) return {};
  await db.invoice.updateMany({ where: { id: { in: filas.map((f) => f.id) } }, data: { sustituidoPorUuid: marca } });
  const conteo: ConteoPorTipo = {};
  for (const f of filas) conteo[f.tipoSat ?? "?"] = (conteo[f.tipoSat ?? "?"] ?? 0) + 1;
  return conteo;
}

/**
 * El orden inverso: llega el ORIGINAL después de su sustituto. Se busca por las
 * columnas escalares de la relación (la primera del XML), que cubren el caso
 * común de un CFDI que sustituye a uno. Relaciones múltiples las recoge el cron.
 */
export async function marcarSiYaFueSustituido(db: Db, companyId: string, invoiceId: string, uuid: string): Promise<boolean> {
  const sustituto = await db.invoice.findFirst({
    where: {
      companyId,
      status: "STAMPED",
      tipoRelacion: "04",
      cfdiRelacionadoUuid: { equals: normalizarUuid(uuid), mode: "insensitive" },
      NOT: { id: invoiceId },
    },
    select: { uuid: true },
  });
  if (!sustituto?.uuid) return false;
  await db.invoice.update({ where: { id: invoiceId }, data: { sustituidoPorUuid: normalizarUuid(sustituto.uuid) } });
  return true;
}

/** Se canceló el sustituto: lo que había sustituido vuelve a contar. */
export async function liberarSustituidosPor(db: Db, companyId: string, uuidsCancelados: Iterable<string | null | undefined>): Promise<number> {
  const lista = variantesUuid(uuidsCancelados);
  if (lista.length === 0) return 0;
  const r = await db.invoice.updateMany({
    where: { companyId, sustituidoPorUuid: { in: lista } },
    data: { sustituidoPorUuid: null },
  });
  return r.count;
}

/** Para los importadores: nunca tumba la importación, sólo avisa. */
export async function registrarSustitucion(
  db: Db,
  companyId: string,
  invoice: { id: string; uuid: string; relacionados: Relacionados },
): Promise<void> {
  try {
    await marcarSustituidos(db, companyId, invoice);
    await marcarSiYaFueSustituido(db, companyId, invoice.id, invoice.uuid);
  } catch (e) {
    console.warn(`[cfdi-sustitucion] ${invoice.uuid}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
