import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";

// GET /api/hallazgos/cartera — agregado multi-empresa para el rail del
// Copiloto (v2): total y críticos por empresa, batcheado en 2 queries.
// El detalle por empresa vive en /api/hallazgos (empresa activa).
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ids = await empresasAccesiblesIds(session.user.id);
  if (ids.length === 0) return NextResponse.json({ empresas: 0, total: 0, criticos: 0, porEmpresa: [] });

  const now = new Date();
  const [grupos, companies] = await Promise.all([
    prisma.fiscalHallazgo.groupBy({
      by: ["companyId", "severidad"],
      where: {
        companyId: { in: ids },
        estado: "ABIERTO",
        OR: [{ posponerHasta: null }, { posponerHasta: { lte: now } }],
      },
      _count: { id: true },
    }),
    prisma.company.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, razonSocial: true },
    }),
  ]);

  const nombrePor = new Map(companies.map((c) => [c.id, c.razonSocial]));
  const porEmpresaMap = new Map<string, { total: number; criticos: number }>();
  for (const g of grupos) {
    const cur = porEmpresaMap.get(g.companyId) ?? { total: 0, criticos: 0 };
    cur.total += g._count.id;
    if (g.severidad === "error") cur.criticos += g._count.id;
    porEmpresaMap.set(g.companyId, cur);
  }
  const porEmpresa = [...porEmpresaMap.entries()]
    .map(([companyId, v]) => ({
      companyId,
      razonSocial: nombrePor.get(companyId) ?? "—",
      ...v,
    }))
    .sort((a, b) => b.criticos - a.criticos || b.total - a.total);

  return NextResponse.json({
    empresas: porEmpresa.length,
    total: porEmpresa.reduce((t, e) => t + e.total, 0),
    criticos: porEmpresa.reduce((t, e) => t + e.criticos, 0),
    porEmpresa: porEmpresa.slice(0, 5),
  });
}
