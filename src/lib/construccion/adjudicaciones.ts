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

export type LineaIva = { importe: number; ivaTasa: number | null };

/**
 * Desglose de un pagable a partir de sus líneas SIN IVA, cada una con su tasa
 * (null = exento, 0 = tasa 0 %, 0.16 = gravado). El IVA se redondea por
 * línea y luego se suma — como el CFDI traslada por concepto —, así el total
 * cuadra al centavo con la factura que va a llegar.
 */
export function desgloseIva(lineas: LineaIva[]): { subtotal: number; iva: number; total: number } {
  let subtotal = 0;
  let iva = 0;
  for (const l of lineas) {
    subtotal += l.importe;
    iva += round2(l.importe * (l.ivaTasa ?? 0));
  }
  subtotal = round2(subtotal);
  iva = round2(iva);
  return { subtotal, iva, total: round2(subtotal + iva) };
}

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
      origen: true,
      partidas: { select: { importe: true, ivaTasa: true, cotizacionGanadoraId: true } },
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
  const lineasByCot = new Map<string, LineaIva[]>();
  for (const p of sol.partidas) {
    if (!p.cotizacionGanadoraId) continue;
    const arr = lineasByCot.get(p.cotizacionGanadoraId) ?? [];
    arr.push({
      importe: Number(p.importe),
      ivaTasa: p.ivaTasa == null ? null : Number(p.ivaTasa),
    });
    lineasByCot.set(p.cotizacionGanadoraId, arr);
  }

  // Sólo las requisiciones de OBRA (origen null) llevan IVA en el pagable.
  // Hospital (y cualquier origen futuro) conserva total = Σ importe, sin
  // desglose: su flujo de factura/pago no se toca desde aquí.
  const conIva = sol.origen == null;

  let created = 0;
  for (const [cotId, lineas] of lineasByCot) {
    const c = cotById.get(cotId);
    if (!c) continue;
    const d = desgloseIva(lineas);
    const montos = conIva
      ? { total: d.total, subtotal: d.subtotal, iva: d.iva }
      : { total: d.subtotal };
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
        ...montos,
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
