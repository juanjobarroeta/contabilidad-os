/**
 * GET /api/hospital/episodios/[id]/accesos[?limit=200&antes=<ISO>]
 *
 * Quién abrió este expediente, su cuenta o descargó sus documentos (NOM-024
 * §5.9, LFPDPPP): [{ at, userEmail, accion, detalle, … }], más reciente
 * primero, últimos 200 por default; `antes` pagina hacia atrás.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { accesoResumen } from "@/lib/hospital/accesos";

const MAX = 500;

export const GET = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  await requireMembership(ep.companyId, undefined, req);
  await requireModule(ep.companyId, "HOSPITAL", req);

  const { searchParams } = new URL(req.url);
  const limit = Math.min(MAX, Math.max(1, Number(searchParams.get("limit") ?? 200) || 200));
  const antesParam = searchParams.get("antes");
  const antes = antesParam ? new Date(antesParam) : null;
  if (antes && Number.isNaN(antes.getTime())) return error("antes inválido (ISO)");

  const accesos = await prisma.hospAcceso.findMany({
    where: { companyId: ep.companyId, episodioId: ep.id, ...(antes ? { at: { lt: antes } } : {}) },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: limit,
  });

  return NextResponse.json(accesos.map(accesoResumen));
});
