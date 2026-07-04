/**
 * Cuenta corriente del proveedor: aplicación de pagos a adjudicaciones.
 *
 * Un PagoProveedor es un abono a la cuenta del proveedor; PagoAplicacion lo
 * reparte entre adjudicaciones (parciales permitidas). Aquí vive la lógica
 * compartida de validación + recomputo de estados que usan los endpoints de
 * pagos-proveedor y el atajo POST /adjudicaciones/:id/pagar.
 */

import type { Prisma } from "@prisma/client";

const EPS = 0.01; // tolerancia de centavos

export type AplicacionInput = { adjudicacionId: string; monto: number };

/** Suma aplicada a una adjudicación (0 si no tiene aplicaciones). */
export async function aplicadoDeAdjudicacion(
  tx: Prisma.TransactionClient,
  adjudicacionId: string
): Promise<number> {
  const agg = await tx.pagoAplicacion.aggregate({
    where: { adjudicacionId },
    _sum: { monto: true },
  });
  return agg._sum.monto ?? 0;
}

/**
 * Saldo abierto de una adjudicación. Tolerancia legacy: las adjudicaciones
 * marcadas PAGADA/CONCILIADA por el flujo anterior (sin aplicaciones) cuentan
 * como saldadas.
 */
export function saldoDe(adj: { total: number; estado: string }, aplicado: number): number {
  if ((adj.estado === "PAGADA" || adj.estado === "CONCILIADA") && aplicado <= EPS) return 0;
  return Math.max(0, adj.total - aplicado);
}

/**
 * Recalcula el estado de una adjudicación a partir de sus aplicaciones:
 * saldada → PAGADA (fija pagadaAt la primera vez), algo aplicado → PARCIAL,
 * nada → POR_PAGAR. No toca CONCILIADA (estado terminal de conciliación) ni
 * degrada PAGADA legacy sin aplicaciones.
 */
export async function recomputeAdjudicacionEstado(
  tx: Prisma.TransactionClient,
  adjudicacionId: string,
  fecha: Date
): Promise<void> {
  const adj = await tx.solicitudAdjudicacion.findUnique({
    where: { id: adjudicacionId },
    select: { id: true, total: true, estado: true, pagadaAt: true },
  });
  if (!adj || adj.estado === "CONCILIADA") return;

  const aplicado = await aplicadoDeAdjudicacion(tx, adjudicacionId);
  if (aplicado <= EPS) {
    // Sin aplicaciones: PAGADA legacy (flujo anterior) se respeta.
    if (adj.estado !== "PAGADA") {
      await tx.solicitudAdjudicacion.update({
        where: { id: adjudicacionId },
        data: { estado: "POR_PAGAR", pagadaAt: null },
      });
    }
    return;
  }

  const saldada = aplicado >= adj.total - EPS;
  await tx.solicitudAdjudicacion.update({
    where: { id: adjudicacionId },
    data: {
      estado: saldada ? "PAGADA" : "PARCIAL",
      pagadaAt: saldada ? (adj.pagadaAt ?? fecha) : null,
    },
  });
}

/**
 * Valida y crea las aplicaciones de un pago dentro de una transacción.
 * Reglas: cada adjudicación pertenece a la empresa y (si el pago trae
 * supplierId) al mismo proveedor; monto > 0; no exceder el saldo abierto de
 * cada adjudicación ni el disponible del pago. Devuelve el total aplicado.
 */
export async function aplicarPago(
  tx: Prisma.TransactionClient,
  pago: { id: string; companyId: string; supplierId: string | null; monto: number },
  aplicaciones: AplicacionInput[],
  fecha: Date
): Promise<number> {
  if (aplicaciones.length === 0) return 0;

  const yaAplicado = await tx.pagoAplicacion.aggregate({
    where: { pagoId: pago.id },
    _sum: { monto: true },
  });
  let disponible = pago.monto - (yaAplicado._sum.monto ?? 0);

  let totalAplicado = 0;
  const solicitudesTocadas = new Set<string>();

  for (const a of aplicaciones) {
    if (!(a.monto > 0)) throw new Error("Cada aplicación debe tener monto > 0");
    const adj = await tx.solicitudAdjudicacion.findUnique({
      where: { id: a.adjudicacionId },
      select: { id: true, companyId: true, supplierId: true, total: true, estado: true, solicitudId: true },
    });
    if (!adj || adj.companyId !== pago.companyId) {
      throw new Error(`Adjudicación inválida: ${a.adjudicacionId}`);
    }
    if (pago.supplierId && adj.supplierId && adj.supplierId !== pago.supplierId) {
      throw new Error("La adjudicación pertenece a otro proveedor");
    }
    const aplicado = await aplicadoDeAdjudicacion(tx, adj.id);
    const saldo = saldoDe(adj, aplicado);
    if (a.monto > saldo + EPS) {
      throw new Error(`La aplicación excede el saldo de la adjudicación (saldo ${saldo.toFixed(2)})`);
    }
    if (a.monto > disponible + EPS) {
      throw new Error("Las aplicaciones exceden el monto del pago");
    }

    await tx.pagoAplicacion.create({
      data: { pagoId: pago.id, adjudicacionId: adj.id, monto: a.monto },
    });
    disponible -= a.monto;
    totalAplicado += a.monto;
    solicitudesTocadas.add(adj.solicitudId);

    await recomputeAdjudicacionEstado(tx, adj.id, fecha);
  }

  // Requisiciones padre: PAGADA cuando todos sus proveedores quedaron saldados.
  const { refreshSolicitudPagoEstado } = await import("./adjudicaciones");
  for (const solicitudId of solicitudesTocadas) {
    await refreshSolicitudPagoEstado(tx, solicitudId, fecha);
  }

  return totalAplicado;
}
