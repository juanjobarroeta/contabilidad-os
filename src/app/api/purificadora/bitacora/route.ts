import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// GET /api/purificadora/bitacora?companyId=xxx[&from=YYYY-MM-DD][&to=YYYY-MM-DD][&q=texto]
//
// Bitácora de la empresa: quién hizo qué y cuándo (AuditLog). Sólo OWNER/ADMIN.
// `q` filtra por correo del actor o por acción (contiene, sin mayúsculas).
// Devuelve las 300 entradas más recientes del rango.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "PURIFICADORA", req);

  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const q = searchParams.get("q")?.trim();

  const fromDate = from ? new Date(`${from}T00:00:00.000Z`) : null;
  const toDate = to ? new Date(`${to}T23:59:59.999Z`) : null;
  if ((from && Number.isNaN(fromDate!.getTime())) || (to && Number.isNaN(toDate!.getTime()))) {
    return NextResponse.json({ error: "Fecha inválida" }, { status: 400 });
  }

  const entradas = await prisma.auditLog.findMany({
    where: {
      companyId,
      ...(fromDate || toDate
        ? { createdAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
        : {}),
      ...(q
        ? {
            OR: [
              { actorEmail: { contains: q, mode: "insensitive" } },
              { accion: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true,
      createdAt: true,
      actorEmail: true,
      accion: true,
      entidad: true,
      entidadId: true,
      detalle: true,
    },
  });

  return NextResponse.json({ entradas });
});
