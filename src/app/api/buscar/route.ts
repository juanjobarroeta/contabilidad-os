import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";

// GET /api/buscar?companyId=&q= — contrapartes para la búsqueda global (⌘K).
//
// El paletón sólo buscaba pantallas y empresas: teclear el nombre de un
// proveedor con miles de CFDIs decía «Nada coincide» (reporte real: «Virtus»).
// Toda contraparte vive como fila de Customer (el padrón universal que
// alimenta el sync del SAT), así que una sola consulta cubre clientes y
// proveedores. La fila navega a /facturas?q=RFC — que desde #848 busca en
// TODO el historial.
export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ contrapartes: [] }, { status: e.status });
    throw e;
  }
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId") ?? "";
  const q = (searchParams.get("q") ?? "").trim();
  if (!companyId || q.length < 3) return NextResponse.json({ contrapartes: [] });

  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json({ contrapartes: [] }, { status: 403 });

  const filas = await prisma.customer.findMany({
    where: {
      companyId,
      OR: [
        { razonSocial: { contains: q, mode: "insensitive" } },
        { rfc: { contains: q.toUpperCase() } },
      ],
    },
    select: {
      id: true,
      rfc: true,
      razonSocial: true,
      _count: { select: { invoices: { where: { status: { not: "CANCELLED" } } } } },
    },
    orderBy: { razonSocial: "asc" },
    take: 6,
  });

  return NextResponse.json({
    contrapartes: filas.map((f) => ({
      id: f.id,
      rfc: f.rfc,
      razonSocial: f.razonSocial,
      cfdis: f._count.invoices,
    })),
  });
}
