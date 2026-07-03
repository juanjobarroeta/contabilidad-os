import { prisma } from "./prisma";

// ─────────────────────────────────────────────────────────────────────────────
// Complemento de Pago (REP) detection.
//
// A PPD ("Pago en Parcialidades o Diferido") invoice requires a Complemento de
// Pago (REP) to be issued for each payment received. The REP is legally due by
// the **5th of the month following the payment**. Missing them is a common,
// costly omission — this detector surfaces which ones are still pending and how
// urgent they are.
//
// This covers Direction 1 (emitidos — you received payment on a PPD invoice you
// issued, so YOU owe the complemento). Direction 2 (recibidos — a vendor owes
// YOU the complemento for a PPD gasto you paid) depends on how received PAGO
// CFDIs are linked and is a follow-up.
// ─────────────────────────────────────────────────────────────────────────────

export type Urgencia = "VENCIDO" | "POR_VENCER" | "EN_TIEMPO";

export interface ComplementoPendiente {
  invoiceId: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  cliente: string | null;
  fechaFactura: string; // ISO date
  totalFactura: number;
  totalPagado: number;
  totalComplementado: number;
  montoPendiente: number;
  ultimoPago: string; // ISO date of the most recent matched payment
  fechaLimite: string; // ISO date — 5th of the month after the last payment
  urgencia: Urgencia;
  diasParaVencer: number; // negative if overdue
}

export interface ComplementosResult {
  pendientes: ComplementoPendiente[];
  stats: {
    totalPendientes: number;
    vencidos: number;
    porVencer: number; // due within 7 days
    montoPendiente: number;
  };
}

export interface ComplementoRecibidoPendiente {
  invoiceId: string;
  uuid: string | null;
  proveedor: string | null;
  fechaFactura: string;
  total: number;
  totalPagado: number;
  ultimoPago: string;
  fechaLimite: string;
  urgencia: Urgencia;
  diasParaVencer: number;
}

export interface ComplementosRecibidosResult {
  pendientes: ComplementoRecibidoPendiente[];
  stats: { totalPendientes: number; vencidos: number; porVencer: number };
}

/** Complemento deadline: the 5th of the month AFTER the payment month. */
export function fechaLimiteComplemento(pago: Date): Date {
  const y = pago.getUTCFullYear();
  const m = pago.getUTCMonth(); // 0-11
  const nextMonth = m === 11 ? 0 : m + 1;
  const year = m === 11 ? y + 1 : y;
  return new Date(Date.UTC(year, nextMonth, 5));
}

function classify(fechaLimite: Date, now: Date): { urgencia: Urgencia; dias: number } {
  const dias = Math.ceil((fechaLimite.getTime() - now.getTime()) / 86_400_000);
  if (dias < 0) return { urgencia: "VENCIDO", dias };
  if (dias <= 7) return { urgencia: "POR_VENCER", dias };
  return { urgencia: "EN_TIEMPO", dias };
}

/**
 * Detect PPD invoices that have received payments still missing a Complemento
 * de Pago. Sorted most-urgent first.
 */
export async function detectComplementosPendientes(
  companyId: string,
  now: Date = new Date()
): Promise<ComplementosResult> {
  const ppdInvoices = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO", metodoPago: "PPD", status: "STAMPED" },
    select: {
      id: true,
      uuid: true,
      serie: true,
      folio: true,
      fecha: true,
      total: true,
      customer: { select: { razonSocial: true } },
    },
  });
  if (ppdInvoices.length === 0) {
    return { pendientes: [], stats: { totalPendientes: 0, vencidos: 0, porVencer: 0, montoPendiente: 0 } };
  }

  const ppdIds = ppdInvoices.map((i) => i.id);

  const [matchedPayments, detalleAsignaciones, existingReps] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { companyId, invoiceId: { in: ppdIds }, status: "MATCHED", monto: { gt: 0 } },
      select: { invoiceId: true, fecha: true, monto: true },
    }),
    // Conciliación uno-a-varios: la porción asignada a cada factura cuenta como
    // pago recibido (el movimiento deja invoiceId en NULL, no hay doble conteo).
    prisma.conciliacionDetalle.findMany({
      where: {
        invoiceId: { in: ppdIds },
        bankTransaction: { companyId, status: "MATCHED", monto: { gt: 0 } },
      },
      select: { invoiceId: true, montoAsignado: true, bankTransaction: { select: { fecha: true } } },
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "PAGO", status: "STAMPED", notas: { in: ppdIds } },
      select: { notas: true, total: true },
    }),
  ]);

  // Pagos unificados por factura: movimientos legados 1:1 + porciones asignadas.
  const pagosPorFactura = new Map<string, { fecha: Date; monto: number }[]>();
  for (const p of matchedPayments) {
    if (!p.invoiceId) continue;
    const arr = pagosPorFactura.get(p.invoiceId) ?? [];
    arr.push({ fecha: p.fecha, monto: p.monto });
    pagosPorFactura.set(p.invoiceId, arr);
  }
  for (const d of detalleAsignaciones) {
    const arr = pagosPorFactura.get(d.invoiceId) ?? [];
    arr.push({ fecha: d.bankTransaction.fecha, monto: d.montoAsignado });
    pagosPorFactura.set(d.invoiceId, arr);
  }

  const repTotalByParent = new Map<string, number>();
  for (const rep of existingReps) {
    repTotalByParent.set(rep.notas ?? "", (repTotalByParent.get(rep.notas ?? "") ?? 0) + rep.total);
  }

  const pendientes: ComplementoPendiente[] = [];
  for (const inv of ppdInvoices) {
    const payments = pagosPorFactura.get(inv.id) ?? [];
    if (payments.length === 0) continue;

    const totalPagado = payments.reduce((s, p) => s + p.monto, 0);
    const totalComplementado = repTotalByParent.get(inv.id) ?? 0;
    const montoPendiente = Math.round((totalPagado - totalComplementado) * 100) / 100;
    if (montoPendiente <= 0.01) continue; // fully complemented

    const ultimoPago = payments.reduce((a, b) => (a.fecha > b.fecha ? a : b)).fecha;
    const fechaLimite = fechaLimiteComplemento(ultimoPago);
    const { urgencia, dias } = classify(fechaLimite, now);

    pendientes.push({
      invoiceId: inv.id,
      uuid: inv.uuid,
      serie: inv.serie,
      folio: inv.folio,
      cliente: inv.customer?.razonSocial ?? null,
      fechaFactura: inv.fecha.toISOString().slice(0, 10),
      totalFactura: inv.total,
      totalPagado,
      totalComplementado,
      montoPendiente,
      ultimoPago: ultimoPago.toISOString().slice(0, 10),
      fechaLimite: fechaLimite.toISOString().slice(0, 10),
      urgencia,
      diasParaVencer: dias,
    });
  }

  // Most urgent first (fewest days remaining).
  pendientes.sort((a, b) => a.diasParaVencer - b.diasParaVencer);

  return {
    pendientes,
    stats: {
      totalPendientes: pendientes.length,
      vencidos: pendientes.filter((p) => p.urgencia === "VENCIDO").length,
      porVencer: pendientes.filter((p) => p.urgencia === "POR_VENCER").length,
      montoPendiente: Math.round(pendientes.reduce((s, p) => s + p.montoPendiente, 0) * 100) / 100,
    },
  };
}

/**
 * Direction 2 — complementos a vendor owes YOU.
 *
 * For each PPD EGRESO (gasto) you've paid (matched outgoing bank tx), check
 * whether a received complemento de pago references its UUID via the parsed
 * DoctoRelacionado links. If you paid but no REP references that invoice, the
 * vendor still owes you the complemento — a real risk to your deduction.
 *
 * Accuracy: uses the actual DoctoRelacionado UUID linkage (parsed at import),
 * not an RFC+amount heuristic, so it won't cry wolf.
 */
export async function detectComplementosRecibidosPendientes(
  companyId: string,
  now: Date = new Date()
): Promise<ComplementosRecibidosResult> {
  const ppdGastos = await prisma.invoice.findMany({
    where: { companyId, tipo: "EGRESO", metodoPago: "PPD", status: "STAMPED" },
    select: {
      id: true,
      uuid: true,
      fecha: true,
      total: true,
      customer: { select: { razonSocial: true } },
      bankTransactions: {
        where: { status: "MATCHED", monto: { lt: 0 } }, // outgoing = payments made
        select: { fecha: true, monto: true },
      },
      // Conciliación uno-a-varios: porciones de retiros asignadas a este gasto.
      conciliacionDetalles: {
        where: { bankTransaction: { status: "MATCHED", monto: { lt: 0 } } },
        select: { montoAsignado: true, bankTransaction: { select: { fecha: true } } },
      },
    },
  });

  const paid = ppdGastos.filter(
    (g) => (g.bankTransactions.length > 0 || g.conciliacionDetalles.length > 0) && g.uuid
  );
  if (paid.length === 0) {
    return { pendientes: [], stats: { totalPendientes: 0, vencidos: 0, porVencer: 0 } };
  }

  // Which of these parent UUIDs are referenced by ANY received PAGO complemento?
  const uuids = paid.map((g) => g.uuid!) as string[];
  const links = await prisma.pagoDoctoRelacionado.findMany({
    where: {
      parentUuid: { in: uuids },
      pagoInvoice: { companyId, tipo: "PAGO" },
    },
    select: { parentUuid: true },
  });
  const complementado = new Set(links.map((l) => l.parentUuid));

  const pendientes: ComplementoRecibidoPendiente[] = [];
  for (const g of paid) {
    if (complementado.has(g.uuid!)) continue; // vendor already sent the REP
    // Neto firmado: un reembolso (cargo) resta de lo pagado. Las porciones
    // asignadas (conciliación múltiple) suman por su monto asignado.
    const totalPagado =
      Math.abs(g.bankTransactions.reduce((s, t) => s + t.monto, 0)) +
      g.conciliacionDetalles.reduce((s, d) => s + Math.abs(d.montoAsignado), 0);
    const fechasPago = [
      ...g.bankTransactions.map((t) => t.fecha),
      ...g.conciliacionDetalles.map((d) => d.bankTransaction.fecha),
    ];
    const ultimoPago = fechasPago.reduce((a, b) => (a > b ? a : b));
    const fechaLimite = fechaLimiteComplemento(ultimoPago);
    const { urgencia, dias } = classify(fechaLimite, now);
    pendientes.push({
      invoiceId: g.id,
      uuid: g.uuid,
      proveedor: g.customer?.razonSocial ?? null,
      fechaFactura: g.fecha.toISOString().slice(0, 10),
      total: g.total,
      totalPagado: Math.round(totalPagado * 100) / 100,
      ultimoPago: ultimoPago.toISOString().slice(0, 10),
      fechaLimite: fechaLimite.toISOString().slice(0, 10),
      urgencia,
      diasParaVencer: dias,
    });
  }
  pendientes.sort((a, b) => a.diasParaVencer - b.diasParaVencer);

  return {
    pendientes,
    stats: {
      totalPendientes: pendientes.length,
      vencidos: pendientes.filter((p) => p.urgencia === "VENCIDO").length,
      porVencer: pendientes.filter((p) => p.urgencia === "POR_VENCER").length,
    },
  };
}
