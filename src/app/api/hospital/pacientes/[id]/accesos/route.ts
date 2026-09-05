/**
 * GET /api/hospital/pacientes/[id]/accesos[?limit=200&antes=<ISO>]
 *
 * Bitácora de accesos (NOM-024 / LFPDPPP) del paciente: lecturas de su ficha
 * y de los expedientes y cuentas de todos sus episodios, más reciente
 * primero. `antes` pagina hacia atrás desde ese instante.
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
  const paciente = await prisma.hospPaciente.findUnique({
    where: { id },
    select: { id: true, companyId: true, episodios: { select: { id: true } } },
  });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  await requireMembership(paciente.companyId, undefined, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const { searchParams } = new URL(req.url);
  const limit = Math.min(MAX, Math.max(1, Number(searchParams.get("limit") ?? 200) || 200));
  const antesParam = searchParams.get("antes");
  const antes = antesParam ? new Date(antesParam) : null;
  if (antes && Number.isNaN(antes.getTime())) return error("antes inválido (ISO)");

  const accesos = await prisma.hospAcceso.findMany({
    where: {
      companyId: paciente.companyId,
      OR: [{ pacienteId: paciente.id }, { episodioId: { in: paciente.episodios.map((e) => e.id) } }],
      ...(antes ? { at: { lt: antes } } : {}),
    },
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: limit,
  });

  return NextResponse.json(accesos.map(accesoResumen));
});
