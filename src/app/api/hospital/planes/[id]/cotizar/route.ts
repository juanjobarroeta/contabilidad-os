/**
 * POST /api/hospital/planes/[id]/cotizar
 *
 * Crea la HospCotizacion del plan (partidas del plan + un renglón HONORARIO
 * por médico, folio COT, BORRADOR) y la liga; 409 si ya tiene una viva o si
 * el plan ya está en curso. Al convertirla, el episodio se engancha al plan.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, usuarioDe } from "@/lib/hospital/http";
import { serializarCotizacion } from "@/lib/hospital/cotizacion";
import { cotizarPlan, incluyePlan, serializarPlan } from "@/lib/hospital/plan";
import { pacienteResumen } from "@/lib/hospital/serializar";

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const base = await prisma.hospPlanTratamiento.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!base) throw new AuthzError(404, "Plan no encontrado");

  const { user } = await requireWriter(base.companyId, req);
  await requireModule(base.companyId, "HOSPITAL", req);

  const cotizacion = await cotizarPlan(prisma, { planId: id, usuario: usuarioDe(user) });
  const plan = await prisma.hospPlanTratamiento.findUniqueOrThrow({ where: { id }, include: incluyePlan });

  bitacora(user, req, {
    companyId: base.companyId,
    accion: "hospital.plan.cotizar",
    entidad: "HospPlanTratamiento",
    entidadId: id,
    detalle: { nombre: plan.nombre, cotizacionId: cotizacion.id, folio: cotizacion.folio, total: Number(cotizacion.total), partidas: cotizacion.partidas.length },
  });
  return NextResponse.json(
    {
      cotizacion: { ...serializarCotizacion(cotizacion), paciente: cotizacion.paciente ? pacienteResumen(cotizacion.paciente) : null },
      plan: serializarPlan(plan),
    },
    { status: 201 }
  );
});
