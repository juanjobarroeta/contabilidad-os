/**
 * GET /api/construccion/bank-transactions?companyId=...
 *       [&bankAccountId=...] [&status=UNMATCHED|MATCHED|IGNORED]
 *       [&minMonto=...] [&maxMonto=...] [&limit=100]
 *
 * Bearer-aware thin reader over BankTransaction. Powers the "pick from
 * bank" flow when Katia pays a Gasto or Reembolso: instead of typing
 * a SPEI ref into a prompt, she picks from the list of imported bank
 * transactions (CSV / Belvo) that Juan already loaded in
 * contabilidad-os. This is what makes the two products feel like one
 * system: she picks the ACTUAL line from Santander that matches.
 *
 * The /api/bancos/* endpoints use session-cookie auth so bartiz can't
 * hit them directly. This route is a bearer-compatible wrapper.
 *
 * Default filters:
 *   status=UNMATCHED (usual case — Katia wants to match something)
 *   orderBy fecha DESC
 *   monto negative only (DEBITOs) — payment matches are always outgoing
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const bankAccountId = searchParams.get("bankAccountId");
  const status = searchParams.get("status");
  const minMonto = searchParams.get("minMonto");
  const maxMonto = searchParams.get("maxMonto");
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);
  const onlyDebitos = searchParams.get("onlyDebitos") !== "false"; // default true
  // count=1 → return just { count } (no rows). Used by the dashboard's
  // "movimientos sin conciliar" pendiente, where only the badge matters.
  const countOnly = searchParams.get("count") === "1";

  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const where: Record<string, unknown> = { companyId };
  if (bankAccountId) where.bankAccountId = bankAccountId;
  if (status) where.status = status;
  if (onlyDebitos) where.tipo = "DEBITO";

  // Amount window — useful when suggesting candidates for a specific gasto
  if (minMonto || maxMonto) {
    const montoFilter: Record<string, number> = {};
    if (minMonto) montoFilter.gte = Number(minMonto);
    if (maxMonto) montoFilter.lte = Number(maxMonto);
    where.monto = montoFilter;
  }

  if (countOnly) {
    const count = await prisma.bankTransaction.count({ where });
    return NextResponse.json({ count });
  }

  const txs = await prisma.bankTransaction.findMany({
    where,
    select: {
      id: true,
      fecha: true,
      descripcion: true,
      referencia: true,
      monto: true,
      tipo: true,
      status: true,
      source: true, // "UPLOAD" (CSV/PDF), "BELVO", "MANUAL" (gasto pay flow fallback)
      bankAccount: {
        select: { id: true, banco: true, nombre: true, tipo: true, titular: true },
      },
      // Show what it's currently matched to (if anything) so Katia sees
      // she's not stealing a tx that belongs to an invoice.
      invoice: { select: { id: true, uuid: true, serie: true, folio: true, total: true } },
      rayaPagada: { select: { id: true } },
      gastoPagado: { select: { id: true, beneficiarioNombre: true, importe: true } },
      reembolsoPagado: { select: { id: true, semanaInicio: true, semanaFin: true } },
    },
    orderBy: { fecha: "desc" },
    take: limit,
  });

  return NextResponse.json(txs);
});
