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

  const [matchedPayments, existingReps] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: { companyId, invoiceId: { in: ppdIds }, status: "MATCHED", monto: { gt: 0 } },
      select: { invoiceId: true, fecha: true, monto: true },
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "PAGO", status: "STAMPED", notas: { in: ppdIds } },
      select: { notas: true, total: true },
    }),
  ]);

  const repTotalByParent = new Map<string, number>();
  for (const rep of existingReps) {
    repTotalByParent.set(rep.notas ?? "", (repTotalByParent.get(rep.notas ?? "") ?? 0) + rep.total);
  }

  const pendientes: ComplementoPendiente[] = [];
  for (const inv of ppdInvoices) {
    const payments = matchedPayments.filter((p) => p.invoiceId === inv.id);
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
