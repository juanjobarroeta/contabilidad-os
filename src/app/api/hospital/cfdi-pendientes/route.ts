import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { vincularCfdisVivos } from "@/lib/hospital/episodios-vivos-cfdi";

/**
 * GET /api/hospital/cfdi-pendientes?companyId=…
 *
 * Lo que la liga automática CFDI ↔ episodio no pudo resolver sola (sólo
 * lectura: corre la liga en seco):
 *   · cfdisPendientes      CFDIs de ingreso de clientes con episodios vivos que
 *                          no empatan (monto, fechas, reparto con pagador);
 *   · episodiosSinCfdi     altas de hace más de 7 días con cargos sin factura;
 *   · depositosSinAnticipo depósitos cobrados sin CFDI de anticipo (IVA causado
 *                          sin comprobante, Art. 1-B LIVA), por antigüedad.
 */
export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const r = await vincularCfdisVivos(prisma, companyId, { dry: true });
  return NextResponse.json({
    porLigar: r.vinculados,
    cfdisPendientes: r.cfdisPendientes,
    episodiosSinCfdi: r.episodiosSinCfdi,
    depositosSinAnticipo: r.depositosSinAnticipo,
  });
});
