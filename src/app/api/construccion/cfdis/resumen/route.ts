/**
 * GET /api/construccion/cfdis/resumen?companyId=...
 *
 * Count of CFDIs by link status for the Pendientes dashboard badge.
 * Fast: count-only queries, no suggestion scoring.
 *
 * Response:
 *   {
 *     recibidas: { total, porVincular },
 *     emitidas:  { total, porVincular },
 *     porVincular: N  // combined for the badge
 *   }
 *
 * "por vincular" = stamped + not-cancelled invoices with no
 * ConstruccionCfdiVinculo record (neither VINCULADA nor IGNORADA).
 * Emitidas also exclude invoices already implicitly linked via Estimacion.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const base = {
    companyId,
    uuid: { not: null as null },
    status: { not: "CANCELLED" as const },
    canceladaAt: null,
  };

  const [recibidasTotal, emitidasTotal, recibidasPorVincular, emitidasPorVincular] =
    await Promise.all([
      prisma.invoice.count({ where: { ...base, tipo: "EGRESO" } }),
      prisma.invoice.count({ where: { ...base, tipo: "INGRESO" } }),
      prisma.invoice.count({
        where: { ...base, tipo: "EGRESO", construccionVinculo: null },
      }),
      prisma.invoice.count({
        where: {
          ...base,
          tipo: "INGRESO",
          construccionVinculo: null,
          estimacion: null,
        },
      }),
    ]);

  return NextResponse.json({
    recibidas: { total: recibidasTotal, porVincular: recibidasPorVincular },
    emitidas: { total: emitidasTotal, porVincular: emitidasPorVincular },
    porVincular: recibidasPorVincular + emitidasPorVincular,
  });
});
