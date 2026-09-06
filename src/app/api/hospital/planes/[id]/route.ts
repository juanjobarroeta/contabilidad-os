/**
 * GET   /api/hospital/planes/[id]  → plan con paciente, protocolo, médicos, pagador, cotización y episodio (+ cita de quirófano viva)
 * PATCH /api/hospital/planes/[id]  { …campos…, partidas?, insumos?, honorarios?, estado?, autorizacionPagador?, episodioId? }
 *   · CERRADO / CANCELADO no se editan (409)
 *   · AUTORIZADO exige autorizacionPagador cuando el pagador es ASEGURADORA/EMPRESA (409)
 *   · CANCELADO cancela su cotización si sigue en BORRADOR/ENVIADA
 *   · con cotización viva (BORRADOR/ENVIADA/ACEPTADA) no cambian partidas, honorarios, insumos ni convenio (409)
 *   · EN_CURSO / CERRADO los ponen convertir y alta; `episodioId` liga un episodio abierto sin cotización de por medio
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod, usuarioDe } from "@/lib/hospital/http";
import { incluyeCita, serializarCita } from "@/lib/hospital/citas";
import { actualizarPlan, incluyePlan, planPatchSchema, referenciaCitaPlan, serializarPlan } from "@/lib/hospital/plan";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const plan = await prisma.hospPlanTratamiento.findUnique({ where: { id }, include: incluyePlan });
  if (!plan) throw new AuthzError(404, "Plan no encontrado");

  await requireMembership(plan.companyId, undefined, req);
  await requireModule(plan.companyId, "HOSPITAL", req);

  const cita = await prisma.hospCita.findFirst({
    where: { companyId: plan.companyId, pacienteId: plan.pacienteId, notas: { contains: referenciaCitaPlan(plan.id) }, estado: { notIn: ["CANCELADA", "NO_ASISTIO"] } },
    include: incluyeCita,
    orderBy: { inicio: "desc" },
  });
  return NextResponse.json({ ...serializarPlan(plan), cita: cita ? serializarCita(cita) : null });
});

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = planPatchSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const base = await prisma.hospPlanTratamiento.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!base) throw new AuthzError(404, "Plan no encontrado");

  const { user } = await requireWriter(base.companyId, req);
  await requireModule(base.companyId, "HOSPITAL", req);

  const r = await actualizarPlan(prisma, { planId: id, cambios: parsed.data, usuario: usuarioDe(user) });

  bitacora(user, req, {
    companyId: base.companyId,
    accion: r.estadoAntes !== r.plan.estado ? "hospital.plan.estado" : "hospital.plan.editar",
    entidad: "HospPlanTratamiento",
    entidadId: id,
    detalle: { nombre: r.plan.nombre, cambios: r.cambios, de: r.estadoAntes, a: r.plan.estado, total: Number(r.plan.total), cotizacionCancelada: r.cotizacionCancelada },
  });
  return NextResponse.json(serializarPlan(r.plan));
});
