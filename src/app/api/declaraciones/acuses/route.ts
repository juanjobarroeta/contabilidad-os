import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";

// GET /api/declaraciones/acuses
// Declaraciones (de todas las empresas accesibles) que conservan un acuse PDF
// descargable — capturado a mano o traído por el backfill de Syntage.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ids = await empresasAccesiblesIds(session.user.id);
  if (ids.length === 0) return NextResponse.json({ acuses: [] });

  const [rows, companies] = await Promise.all([
    prisma.taxDeclaration.findMany({
      where: { companyId: { in: ids }, acusePdf: { not: null } },
      select: { id: true, companyId: true, tipo: true, periodo: true, fechaPresentacion: true },
      orderBy: [{ periodo: "desc" }, { tipo: "asc" }],
    }),
    prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, razonSocial: true, rfc: true } }),
  ]);
  const byId = new Map(companies.map((c) => [c.id, c]));

  return NextResponse.json({
    acuses: rows.map((r) => ({
      id: r.id,
      tipo: r.tipo,
      periodo: r.periodo,
      fechaPresentacion: r.fechaPresentacion ? r.fechaPresentacion.toISOString().slice(0, 10) : null,
      razonSocial: byId.get(r.companyId)?.razonSocial ?? "",
      rfc: byId.get(r.companyId)?.rfc ?? "",
    })),
  });
}
