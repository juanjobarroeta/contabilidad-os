import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/refacciones?companyId=…&q=…&page=1
//
// Catálogo de refacciones con existencia (Σ kardex) y valor de inventario.
// Búsqueda del lado servidor (número de parte / descripción) y paginado —
// el catálogo derivado puede tener decenas de miles de partes.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 100;
const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const q = (searchParams.get("q") ?? "").trim();
  const page = Math.max(1, Number(searchParams.get("page") ?? 1) || 1);

  const where = {
    companyId,
    ...(q
      ? {
          OR: [
            { numeroParte: { contains: q, mode: "insensitive" as const } },
            { descripcion: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [total, refacciones] = await Promise.all([
    prisma.refaccion.count({ where }),
    prisma.refaccion.findMany({
      where,
      orderBy: { descripcion: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, numeroParte: true, descripcion: true, ultimoCosto: true, ultimoPrecio: true },
    }),
  ]);

  const ids = refacciones.map((r) => r.id);
  const sumas = ids.length
    ? await prisma.refaccionMovimiento.groupBy({
        by: ["refaccionId"],
        where: { refaccionId: { in: ids } },
        _sum: { cantidad: true },
        _count: { _all: true },
      })
    : [];
  const porRefaccion = new Map(sumas.map((s) => [s.refaccionId, s]));

  return NextResponse.json({
    total,
    page,
    pageSize: PAGE_SIZE,
    refacciones: refacciones.map((r) => {
      const s = porRefaccion.get(r.id);
      const existencia = r2(s?._sum.cantidad ?? 0);
      return {
        ...r,
        existencia,
        movimientos: s?._count._all ?? 0,
        valorInventario: existencia > 0 ? r2(existencia * r.ultimoCosto) : 0,
      };
    }),
  });
});
