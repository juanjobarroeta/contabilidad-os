/**
 * POST /api/hospital/planes/[id]/programar { fechaProgramada, recursoId, medicoId?, duracionMinutos? }
 *
 * Agenda el quirófano (HospCita CIRUGIA; PROCEDIMIENTO en sala/consultorio)
 * con la duración del plan/protocolo (default 60 min) y deja la fecha en el
 * plan. 409 si empalma con otra cita viva del recurso. Reprogramar cancela la
 * cita anterior del plan. El plan pasa a EN_CURSO cuando la cotización se
 * convierte en episodio, no aquí.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { serializarCita } from "@/lib/hospital/citas";
import { programarPlan, serializarPlan } from "@/lib/hospital/plan";

const schema = z.object({
  fechaProgramada: fechaSchema,
  recursoId: z.string().min(1),
  medicoId: z.string().nullable().optional(),
  duracionMinutos: z.number().int().positive().max(1440).nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const base = await prisma.hospPlanTratamiento.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!base) throw new AuthzError(404, "Plan no encontrado");

  const { user } = await requireWriter(base.companyId, req);
  await requireModule(base.companyId, "HOSPITAL", req);

  const r = await programarPlan(prisma, {
    planId: id,
    fechaProgramada: new Date(d.fechaProgramada),
    recursoId: d.recursoId,
    medicoId: d.medicoId,
    duracionMinutos: d.duracionMinutos ?? null,
    usuario: usuarioDe(user),
  });

  bitacora(user, req, {
    companyId: base.companyId,
    accion: "hospital.plan.programar",
    entidad: "HospPlanTratamiento",
    entidadId: id,
    detalle: {
      nombre: r.plan.nombre,
      citaId: r.cita.id,
      recurso: r.cita.recurso.nombre,
      inicio: r.cita.inicio.toISOString(),
      fin: r.cita.fin.toISOString(),
      citaCanceladaId: r.citaCanceladaId,
    },
  });
  return NextResponse.json({ plan: serializarPlan(r.plan), cita: serializarCita(r.cita) }, { status: 201 });
});
