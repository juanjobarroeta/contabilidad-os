/**
 * Helpers for building a requisición's líneas + ofertas (cotizaciones) from a
 * single payload — shared by the create (POST) and draft-rebuild (PUT) routes.
 *
 * Offers reference partidas by `partidaIndex` (position in the partidas array)
 * so the client can send everything in one request without knowing the
 * persisted ids yet. We create the partidas in order, then map each offer line
 * to the freshly-created partida id.
 */

import type { Prisma } from "@prisma/client";

const round2 = (n: number) => Math.round(n * 100) / 100;

export type DraftPartidaInput = {
  insumoId?: string;
  descripcion: string;
  unidad?: string | null;
  cantidad: number;
  precioUnitario?: number;
  presupuestoPartidaId?: string;
};

export type DraftOfferInput = {
  supplierId?: string | null;
  supplierNombre: string;
  tieneCredito?: boolean;
  diasEntrega?: number | null;
  lineas: { partidaIndex: number; precioUnitario: number }[];
};

/**
 * Creates the partidas (in array order) and the offer cotizaciones for a
 * solicitud inside a transaction. Returns the solicitud total (Σ partida
 * importe) so the caller can persist it on the header.
 */
export async function buildPartidasAndOffers(
  tx: Prisma.TransactionClient,
  solicitudId: string,
  partidas: DraftPartidaInput[],
  offers: DraftOfferInput[] = []
): Promise<{ total: number }> {
  const ids: string[] = [];
  let total = 0;
  for (const p of partidas) {
    const precioUnitario = p.precioUnitario ?? 0;
    const importe = round2(p.cantidad * precioUnitario);
    total += importe;
    const created = await tx.solicitudPartida.create({
      data: {
        solicitudId,
        insumoId: p.insumoId ?? null,
        descripcion: p.descripcion,
        unidad: p.unidad ?? null,
        cantidad: p.cantidad,
        precioUnitario,
        importe,
        presupuestoPartidaId: p.presupuestoPartidaId ?? null,
      },
      select: { id: true },
    });
    ids.push(created.id);
  }

  for (const o of offers) {
    const lineas = o.lineas
      .filter((l) => ids[l.partidaIndex] != null && l.precioUnitario > 0)
      .map((l) => ({
        solicitudPartidaId: ids[l.partidaIndex],
        precioUnitario: l.precioUnitario,
        importe: round2((partidas[l.partidaIndex]?.cantidad ?? 0) * l.precioUnitario),
      }));
    if (lineas.length === 0) continue;
    const cotTotal = round2(lineas.reduce((a, l) => a + l.importe, 0));
    await tx.solicitudCompraCotizacion.create({
      data: {
        solicitudId,
        supplierId: o.supplierId ?? null,
        supplierNombre: o.supplierNombre,
        tieneCredito: o.tieneCredito ?? false,
        diasEntrega: o.diasEntrega ?? null,
        total: cotTotal,
        partidas: { create: lineas },
      },
    });
  }

  return { total: round2(total) };
}
