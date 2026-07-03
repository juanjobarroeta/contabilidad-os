/**
 * GET /api/construccion/adjudicaciones?companyId=…[&estado=POR_PAGAR|PAGADA]
 *
 * The per-supplier payables tesorería works from: each row is one supplier's
 * awarded slice of a requisición (its own total, credit condition, delivery
 * lead time and payment state). Built when a requisición is authorized.
 *
 * Cuentas por pagar / Tesorería consume this directly — the due date is derived
 * client-side from the approval date + the supplier's credit days.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const estado = searchParams.get("estado");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const rows = await prisma.solicitudAdjudicacion.findMany({
    where: { companyId, ...(estado ? { estado } : {}) },
    include: {
      solicitud: {
        select: {
          id: true,
          folio: true,
          aprobadaAt: true,
          proyecto: { select: { id: true, codigo: true, nombre: true } },
        },
      },
      bankTransaction: {
        select: {
          id: true,
          fecha: true,
          monto: true,
          referencia: true,
          bankAccount: { select: { banco: true, nombre: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const out = rows.map((a) => ({
    id: a.id,
    solicitudId: a.solicitudId,
    folio: a.solicitud?.folio ?? "",
    proyecto: a.solicitud?.proyecto ?? null,
    aprobadaAt: a.solicitud?.aprobadaAt ?? null,
    supplierId: a.supplierId,
    supplierNombre: a.supplierNombre,
    tieneCredito: a.tieneCredito,
    diasCredito: a.diasCredito,
    diasEntrega: a.diasEntrega,
    total: a.total,
    estado: a.estado,
    createdAt: a.createdAt,
    enviadaTesoreriaAt: a.enviadaTesoreriaAt,
    pagadaAt: a.pagadaAt,
    conciliadaAt: a.conciliadaAt,
    referenciaPago: a.referenciaPago,
    comprobanteName: a.comprobanteName,
    bankTransaction: a.bankTransaction,
  }));

  return NextResponse.json(out);
});
