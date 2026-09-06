/**
 * GET /api/hospital/episodios/[id]/plan → { plan, comparativo }
 *
 * La cuenta contra lo planeado: cargos ↔ partidas (por servicio, por médico
 * en honorarios, o por categoría + descripción), lo que quedó fuera de plan,
 * el resumen con la desviación y los insumos planeados contra los aplicados
 * (kardex del episodio). 404 si el episodio no tiene plan.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { asegurarCargosEstancia } from "@/lib/hospital/estancia";
import { compararPlanConCuenta } from "@/lib/hospital/plan";

export const GET = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const base = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, pacienteId: true } });
  if (!base) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireMembership(base.companyId, undefined, req);
  await requireModule(base.companyId, "HOSPITAL", req);

  await asegurarCargosEstancia(prisma, id, new Date());
  const r = await compararPlanConCuenta(prisma, id);
  if (!r) throw new AuthzError(404, `El episodio ${base.folio} no tiene plan de tratamiento`);

  registrarAcceso({ companyId: base.companyId, accion: "LECTURA_CUENTA", episodioId: base.id, pacienteId: base.pacienteId, detalle: `Plan vs cuenta ${base.folio}`, user, req });
  return NextResponse.json(r);
});
