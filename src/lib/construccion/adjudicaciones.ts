/**
 * Per-supplier payables (adjudicaciones) for an awarded requisición.
 *
 * When a requisición is authorized, its per-concepto awards
 * (SolicitudPartida.cotizacionGanadoraId) are grouped by winning cotización
 * into one SolicitudAdjudicacion per supplier — the unit tesorería pays. Each
 * carries its own total, credit condition and delivery lead time (copied from
 * the winning quote) so suppliers are paid separately.
 */

import type { Prisma } from "@prisma/client";

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * (Re)build the per-supplier adjudicaciones for a solicitud from its current
 * per-concepto awards. Idempotent for the POR_PAGAR set: existing unpaid
 * adjudicaciones are wiped and rebuilt. If ANY adjudicación is already PAGADA
 * we leave everything as-is (payment has started — don't disturb it).
 */
export async function generateAdjudicaciones(
  tx: Prisma.TransactionClient,
  solicitudId: string
): Promise<number> {
  const sol = await tx.solicitudCompra.findUnique({
    where: { id: solicitudId },
    select: {
      id: true,
      companyId: true,
      partidas: { select: { importe: true, cotizacionGanadoraId: true } },
      cotizaciones: {
        select: {
          id: true,
          supplierId: true,
          supplierNombre: true,
          tieneCredito: true,
          diasCredito: true,
          diasEntrega: true,
        },
      },
    },
  });
  if (!sol) return 0;

  const existing = await tx.solicitudAdjudicacion.findMany({
    where: { solicitudId },
    select: { estado: true },
  });
  if (existing.some((a) => a.estado === "PAGADA")) return existing.length;

  await tx.solicitudAdjudicacion.deleteMany({
    where: { solicitudId, estado: "POR_PAGAR" },
  });

  const cotById = new Map(sol.cotizaciones.map((c) => [c.id, c]));
  const totalByCot = new Map<string, number>();
  for (const p of sol.partidas) {
    if (!p.cotizacionGanadoraId) continue;
    totalByCot.set(
      p.cotizacionGanadoraId,
      round2((totalByCot.get(p.cotizacionGanadoraId) ?? 0) + Number(p.importe))
    );
  }

  let created = 0;
  for (const [cotId, total] of totalByCot) {
    const c = cotById.get(cotId);
    if (!c) continue;
    await tx.solicitudAdjudicacion.create({
      data: {
        companyId: sol.companyId,
        solicitudId,
        cotizacionId: cotId,
        supplierId: c.supplierId ?? null,
        supplierNombre: c.supplierNombre,
        tieneCredito: c.tieneCredito,
        diasCredito: c.diasCredito ?? null,
        diasEntrega: c.diasEntrega ?? null,
        total,
      },
    });
    created++;
  }
  return created;
}

/**
 * Flip the parent solicitud to PAGADA once every adjudicación is paid. Called
 * after each per-supplier payment. No-op while any supplier is still pending.
 */
export async function refreshSolicitudPagoEstado(
  tx: Prisma.TransactionClient,
  solicitudId: string,
  fecha: Date
): Promise<void> {
  const adjs = await tx.solicitudAdjudicacion.findMany({
    where: { solicitudId },
    select: { estado: true },
  });
  // "Pagado" for the parent = pago registrado (PAGADA) o ya conciliado
  // (CONCILIADA); ambos cuentan como que el proveedor ya no está por pagar.
  const pagado = (e: string) => e === "PAGADA" || e === "CONCILIADA";
  if (adjs.length > 0 && adjs.every((a) => pagado(a.estado))) {
    await tx.solicitudCompra.update({
      where: { id: solicitudId },
      data: { estado: "PAGADA", pagadaAt: fecha },
    });
  }
}
