/**
 * GET /api/bancos/transactions/[txId]/candidates
 *
 * For an UNMATCHED bank transaction, returns the most likely candidates
 * across all four entity types it could be matched against:
 *
 *   { gastos: [], reembolsos: [], rayas: [], solicitudesCompra: [], invoices: [] }
 *
 * Ranking heuristics:
 *   - Same company (always)
 *   - Amount within ±15% window (debit-direction matters: BT.monto < 0
 *     ⇒ outgoing ⇒ matches Gasto/Reembolso/Raya importes; BT.monto > 0
 *     ⇒ incoming ⇒ matches Invoice totals)
 *   - Date proximity: prefer entities created/dated within ±10 days
 *   - For gastos/reembolsos/rayas: only those without bankTransactionId
 *     (un-paid yet — eligible for linking)
 *
 * Used by the bancos UI to show "este movimiento podría ser…" suggestions
 * when an admin opens the match dropdown. Closes the loop with bartiz:
 * Katia pays a gasto in bartiz → BT auto-linked. Juan imports a CSV in
 * contabilidad-os → these candidates surface uncategorized expenses
 * he might want to reconcile.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";

type Params = { params: Promise<{ txId: string }> };

const DELTA_PCT = 0.15;
const DATE_WINDOW_DAYS = 10;

export async function GET(_req: Request, { params }: Params) {
  // Sesión web O token de servicio (Bearer) — el satélite JCPT usa las
  // sugerencias en su propio UI de conciliación.
  let userId: string;
  try {
    userId = (await requireUser(_req)).id;
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { txId } = await params;
  const txRow = await prisma.bankTransaction.findUnique({
    where: { id: txId },
    select: { id: true, companyId: true, monto: true, fecha: true, tipo: true },
  });
  if (!txRow) return NextResponse.json({ error: "Transacción no encontrada" }, { status: 404 });
  const tx = { ...txRow, monto: Number(txRow.monto) };

  const member = await getEffectiveCompanyMembership(userId, tx.companyId);
  if (!member) return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const abs = Math.abs(tx.monto);
  const minAmt = abs * (1 - DELTA_PCT);
  const maxAmt = abs * (1 + DELTA_PCT);
  const dateLow = new Date(tx.fecha);
  dateLow.setDate(dateLow.getDate() - DATE_WINDOW_DAYS);
  const dateHigh = new Date(tx.fecha);
  dateHigh.setDate(dateHigh.getDate() + DATE_WINDOW_DAYS);

  const isOutflow = tx.monto < 0 || tx.tipo === "DEBITO";
  const isInflow = tx.monto > 0 || tx.tipo === "CREDITO";

  // ── Outgoing-side candidates (un-paid Gastos / Reembolsos / Rayas / OCs) ──
  const [gastos, reembolsos, rayas, solicitudesCompra] = isOutflow
    ? await Promise.all([
        prisma.gasto.findMany({
          where: {
            companyId: tx.companyId,
            bankTransactionId: null,
            estado: { in: ["PENDIENTE", "APROBADO"] },
            importe: { gte: minAmt, lte: maxAmt },
            createdAt: { gte: dateLow, lte: dateHigh },
          },
          select: {
            id: true,
            beneficiarioNombre: true,
            importe: true,
            descripcion: true,
            createdAt: true,
            proyecto: { select: { codigo: true } },
          },
          take: 8,
          orderBy: { createdAt: "desc" },
        }),
        prisma.reembolsoSemanal.findMany({
          where: {
            companyId: tx.companyId,
            bankTransactionId: null,
            estado: { in: ["SUBMITTED", "REVISADO"] },
            totalReembolso: { gte: minAmt, lte: maxAmt },
            semanaInicio: { gte: dateLow, lte: dateHigh },
          },
          select: {
            id: true,
            totalReembolso: true,
            semanaInicio: true,
            semanaFin: true,
            proyecto: { select: { codigo: true } },
          },
          take: 5,
          orderBy: { semanaInicio: "desc" },
        }),
        prisma.rayaSemanal.findMany({
          where: {
            companyId: tx.companyId,
            bankTransactionId: null,
            estado: { in: ["BORRADOR", "APROBADA"] },
            totalDestajo: { gte: minAmt, lte: maxAmt },
            semanaInicio: { gte: dateLow, lte: dateHigh },
          },
          select: {
            id: true,
            totalDestajo: true,
            semanaInicio: true,
            semanaFin: true,
            cuadrilla: { select: { nombre: true } },
            proyecto: { select: { codigo: true } },
          },
          take: 5,
          orderBy: { semanaInicio: "desc" },
        }),
        prisma.solicitudCompra.findMany({
          where: {
            companyId: tx.companyId,
            bankTransactionId: null,
            estado: "APROBADA",
            total: { gte: minAmt, lte: maxAmt },
            // OCs use createdAt as the timestamp window — matches when SPEI
            // hits within ~10 days of OC creation, the typical lag.
            createdAt: { gte: dateLow, lte: dateHigh },
          },
          select: {
            id: true,
            folio: true,
            total: true,
            createdAt: true,
            supplier: { select: { razonSocial: true, rfc: true } },
            proyecto: { select: { codigo: true } },
          },
          take: 8,
          orderBy: { createdAt: "desc" },
        }),
      ])
    : [[], [], [], []];

  // ── Incoming-side candidates (Invoices not yet linked) ──
  const invoices = isInflow
    ? await prisma.invoice.findMany({
        where: {
          companyId: tx.companyId,
          // Invoice doesn't have a bankTransactionId direct — match through
          // BankTransaction.invoiceId being null on this tx + the candidate
          // having no MATCHED tx pointing at it. Cheaper: just filter by
          // amount + date and let the user decide.
          total: { gte: minAmt, lte: maxAmt },
          fecha: { gte: dateLow, lte: dateHigh },
          status: "STAMPED",
        },
        select: {
          id: true,
          uuid: true,
          folio: true,
          total: true,
          fecha: true,
          customer: { select: { razonSocial: true } },
        },
        take: 8,
        orderBy: { fecha: "desc" },
      }).catch(() => [])
    : [];

  return NextResponse.json({ tx, gastos, reembolsos, rayas, solicitudesCompra, invoices });
}
