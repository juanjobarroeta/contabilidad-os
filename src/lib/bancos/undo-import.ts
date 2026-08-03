// ─────────────────────────────────────────────────────────────────────────────
// "Deshacer última importación" — revierte un lote de estado de cuenta que cayó
// en la empresa/cuenta equivocada. Borra SOLO los movimientos del lote que aún
// están sin conciliar (UNMATCHED) o ignorados sin asientos (IGNORED de import),
// y CONSERVA los que ya se conciliaron con un CFDI (borrarlos rompería trabajo
// hecho). El lote se marca como deshecho (auditoría), no se elimina.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";

// Intención de "deshacer la última importación": un verbo de reversión + una
// referencia a la importación/movimientos/subida. Así "deshacer conciliación" u
// otras reversiones NO la disparan. PURA (testeable sin DB).
const DESHACER_VERBO = /\b(deshacer|deshaz|deshace|revertir|revierte|revierta|revoca(r)?)\b/i;
const DESHACER_OBJETO = /(importaci|movimient|estado\s+de\s+cuenta|sub[íi]|la\s+subida|lo\s+que\s+sub)/i;

export function esIntencionDeshacer(body: string): boolean {
  return DESHACER_VERBO.test(body) && DESHACER_OBJETO.test(body);
}

export interface LoteImportado {
  id: string;
  createdAt: Date;
  banco: string | null;
  periodo: string | null;
  count: number;
  bankAccountId: string;
  cuentaEtiqueta: string;
  /** Movimientos del lote que aún se pueden borrar (no conciliados). */
  borrables: number;
  /** Movimientos ya conciliados que se conservarían. */
  conciliados: number;
}

/** Últimos 4 dígitos de un número (para etiquetar la cuenta). */
function ult4(n: string | null | undefined): string | null {
  const d = (n ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

/** Ventana para agrupar como UN mismo "lote" las importaciones sin rastrear que
 *  ocurrieron casi juntas (subidas seguidas). Previo al tracking de lotes. */
const CLUSTER_GAP_MS = 15 * 60 * 1000;

/**
 * Encuentra el ÚLTIMO lote importado (no deshecho) de la empresa, con cuántos
 * movimientos son borrables vs. ya conciliados. null si no hay ninguno.
 *
 * Fallback histórico: si la empresa no tiene NINGÚN lote rastreado (movimientos
 * importados antes de que existiera el tracking), busca el cúmulo de movimientos
 * de importación MÁS RECIENTE sin lote, lo MATERIALIZA en un ImportBatch real
 * (etiquetando esos movimientos) y lo devuelve — así el deshacer funciona igual
 * para importaciones viejas. Sólo agrupa lo reciente (ventana de 15 min sobre el
 * último movimiento sin lote), nunca movimientos antiguos legítimos.
 */
export async function findUltimoLoteImportado(companyId: string): Promise<LoteImportado | null> {
  const batch = await prisma.importBatch.findFirst({
    where: { companyId, undoneAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, createdAt: true, banco: true, periodo: true, count: true, bankAccountId: true,
      bankAccount: { select: { banco: true, nombre: true, numeroCuenta: true, clabe: true } },
    },
  });
  if (!batch) return materializarClusterSinLote(companyId);

  const [borrables, total] = await Promise.all([
    prisma.bankTransaction.count({ where: whereBorrables(batch.id, companyId) }),
    prisma.bankTransaction.count({ where: { importBatchId: batch.id, companyId } }),
  ]);

  const t = ult4(batch.bankAccount.numeroCuenta) ?? ult4(batch.bankAccount.clabe);
  const cuentaEtiqueta =
    `${batch.bankAccount.banco} ${batch.bankAccount.nombre}` + (t ? ` (terminación ${t})` : "");

  return {
    id: batch.id,
    createdAt: batch.createdAt,
    banco: batch.banco,
    periodo: batch.periodo,
    count: batch.count,
    bankAccountId: batch.bankAccountId,
    cuentaEtiqueta,
    borrables,
    conciliados: total - borrables,
  };
}

/**
 * Lista los últimos lotes importados (no deshechos) de la empresa, con cuántos
 * movimientos siguen borrables vs. ya conciliados — para la UI de "deshacer una
 * importación" (hub y satélites como JCPT). Orden: más reciente primero.
 */
export async function listarLotesImportados(companyId: string, take = 10): Promise<LoteImportado[]> {
  const batches = await prisma.importBatch.findMany({
    where: { companyId, undoneAt: null },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true, createdAt: true, banco: true, periodo: true, count: true, bankAccountId: true,
      bankAccount: { select: { banco: true, nombre: true, numeroCuenta: true, clabe: true } },
    },
  });

  return Promise.all(
    batches.map(async (batch) => {
      const [borrables, total] = await Promise.all([
        prisma.bankTransaction.count({ where: whereBorrables(batch.id, companyId) }),
        prisma.bankTransaction.count({ where: { importBatchId: batch.id, companyId } }),
      ]);
      const t = ult4(batch.bankAccount.numeroCuenta) ?? ult4(batch.bankAccount.clabe);
      return {
        id: batch.id,
        createdAt: batch.createdAt,
        banco: batch.banco,
        periodo: batch.periodo,
        count: batch.count,
        bankAccountId: batch.bankAccountId,
        cuentaEtiqueta:
          `${batch.bankAccount.banco} ${batch.bankAccount.nombre}` + (t ? ` (terminación ${t})` : ""),
        borrables,
        conciliados: total - borrables,
      };
    })
  );
}

/**
 * Materializa el cúmulo de importación reciente SIN lote (histórico, previo al
 * tracking) en un ImportBatch real, etiquetando esos movimientos. Devuelve el
 * lote resultante, o null si no hay movimientos sin lote. Sólo agrupa fuentes de
 * importación (WHATSAPP/UPLOAD), nunca sincronización automática (BELVO/PADEL).
 */
async function materializarClusterSinLote(companyId: string): Promise<LoteImportado | null> {
  const ultimo = await prisma.bankTransaction.findFirst({
    where: { companyId, importBatchId: null, source: { in: ["WHATSAPP", "UPLOAD"] } },
    orderBy: { createdAt: "desc" },
    select: {
      bankAccountId: true, createdAt: true, source: true,
      bankAccount: { select: { banco: true, nombre: true, numeroCuenta: true, clabe: true } },
    },
  });
  if (!ultimo) return null;

  const desde = new Date(ultimo.createdAt.getTime() - CLUSTER_GAP_MS);
  const scope: Prisma.BankTransactionWhereInput = {
    companyId,
    importBatchId: null,
    bankAccountId: ultimo.bankAccountId,
    source: ultimo.source,
    createdAt: { gte: desde, lte: ultimo.createdAt },
  };

  const count = await prisma.bankTransaction.count({ where: scope });
  const nuevo = await prisma.importBatch.create({
    data: { companyId, bankAccountId: ultimo.bankAccountId, source: ultimo.source, count },
    select: { id: true, createdAt: true },
  });
  await prisma.bankTransaction.updateMany({ where: scope, data: { importBatchId: nuevo.id } });

  const [borrables, total] = await Promise.all([
    prisma.bankTransaction.count({ where: whereBorrables(nuevo.id, companyId) }),
    prisma.bankTransaction.count({ where: { importBatchId: nuevo.id, companyId } }),
  ]);
  const t = ult4(ultimo.bankAccount.numeroCuenta) ?? ult4(ultimo.bankAccount.clabe);
  return {
    id: nuevo.id,
    createdAt: nuevo.createdAt,
    banco: null,
    periodo: null,
    count: total,
    bankAccountId: ultimo.bankAccountId,
    cuentaEtiqueta:
      `${ultimo.bankAccount.banco} ${ultimo.bankAccount.nombre}` + (t ? ` (terminación ${t})` : ""),
    borrables,
    conciliados: total - borrables,
  };
}

/** Condición de "borrable": del lote, sin conciliar y sin enlaces duros. */
function whereBorrables(batchId: string, companyId: string): Prisma.BankTransactionWhereInput {
  return {
    importBatchId: batchId,
    companyId,
    status: { in: ["UNMATCHED", "IGNORED"] },
    invoiceId: null,
    taxDeclarationId: null,
    conciliacionDetalles: { none: {} },
  };
}

export interface ResultadoDeshacer {
  borrados: number;
  conservados: number;
}

/**
 * Ejecuta el deshacer: borra los movimientos borrables del lote y marca el lote
 * como deshecho. Idempotente por el marcado (un lote ya deshecho no borra más).
 * Devuelve cuántos se borraron y cuántos se conservaron (conciliados).
 */
export async function deshacerLoteImportado(
  batchId: string,
  companyId: string,
  userId?: string | null
): Promise<ResultadoDeshacer> {
  return prisma.$transaction(async (tx) => {
    const batch = await tx.importBatch.findFirst({
      where: { id: batchId, companyId, undoneAt: null },
      select: { id: true },
    });
    if (!batch) return { borrados: 0, conservados: 0 };

    const conservados = await tx.bankTransaction.count({
      where: { importBatchId: batchId, companyId, NOT: whereBorrables(batchId, companyId) },
    });
    const { count: borrados } = await tx.bankTransaction.deleteMany({
      where: whereBorrables(batchId, companyId),
    });
    await tx.importBatch.update({
      where: { id: batchId },
      data: { undoneAt: new Date(), undoneByUserId: userId ?? null },
    });

    registrarBitacora({
      companyId,
      userId: userId ?? null,
      accion: "bancos.deshacer-importacion",
      entidad: "ImportBatch",
      entidadId: batchId,
      detalle: { borrados, conservados },
    });

    return { borrados, conservados };
  });
}
