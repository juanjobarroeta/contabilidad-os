import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";

// GET /api/facturas/resumen?companyId=xxx
// Year-to-date headline stats for the Facturas screen cards. Aggregated
// server-side so the figures are accurate regardless of how many rows the
// table itself loads.
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const membership = await getEffectiveCompanyMembership(user.id, companyId);
  if (!membership) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const yearFrom = new Date(new Date().getFullYear(), 0, 1);

  const [timbradas, facturado] = await Promise.all([
    // Comprobantes timbrados (emitidos + recibidos) este año.
    prisma.invoice.count({
      where: { companyId, status: "STAMPED", fecha: { gte: yearFrom } },
    }),
    // Total facturado + IVA trasladado: sólo INGRESO timbrado (lo que emites).
    prisma.invoice.aggregate({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: yearFrom } },
      _sum: { total: true, totalImpuestos: true },
    }),
  ]);

  return NextResponse.json({
    timbradas,
    totalFacturado: facturado._sum.total ?? 0,
    ivaCobrado: facturado._sum.totalImpuestos ?? 0,
  });
}
