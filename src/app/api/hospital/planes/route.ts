/**
 * GET  /api/hospital/planes?companyId=…[&pacienteId=&estado=&protocoloId=&desde=&hasta=&q=]
 *      · `desde`/`hasta` acotan la fecha programada (día local completo)
 * POST /api/hospital/planes { companyId, pacienteId, protocoloId?, pagadorId?, medicoId?, anestesiologoId?, recursoId?, fechaProgramada?,
 *                             partidas?, insumos?, honorarios?, notas?, nombre?, tipoEpisodio?, … }
 *      · sin partidas → las del protocolo preciadas con el convenio del pagador (o el del paciente); partidas explícitas mandan
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospPlanEstado, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, rangoDeQuery, usuarioDe } from "@/lib/hospital/http";
import { PLAN_ESTADOS, crearPlan, incluyePlan, planCamposSchema, serializarPlan } from "@/lib/hospital/plan";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const pacienteId = searchParams.get("pacienteId");
  const protocoloId = searchParams.get("protocoloId");
  const estadoParam = searchParams.get("estado")?.toUpperCase();
  const estados = estadoParam ? estadoParam.split(",").map((s) => s.trim()) : [];
  if (estados.some((s) => !(PLAN_ESTADOS as readonly string[]).includes(s))) return error(`estado inválido (${PLAN_ESTADOS.join(", ")})`);
  const desde = searchParams.get("desde");
  const hasta = searchParams.get("hasta");
  const rango = desde || hasta ? rangoDeQuery(desde, hasta) : null;
  if ((desde || hasta) && !rango) return error("Rango de fechas inválido (desde, hasta)");
  const q = searchParams.get("q")?.trim();

  const where: Prisma.HospPlanTratamientoWhereInput = {
    companyId,
    ...(pacienteId ? { pacienteId } : {}),
    ...(protocoloId ? { protocoloId } : {}),
    ...(estados.length ? { estado: { in: estados as HospPlanEstado[] } } : {}),
    ...(rango ? { fechaProgramada: { gte: rango.desde, lt: rango.hasta } } : {}),
    ...(q
      ? {
          OR: [
            { nombre: { contains: q, mode: "insensitive" } },
            { paciente: { nombre: { contains: q, mode: "insensitive" } } },
            { paciente: { apellidoPaterno: { contains: q, mode: "insensitive" } } },
            { paciente: { apellidoMaterno: { contains: q, mode: "insensitive" } } },
            { cotizacion: { folio: { contains: q, mode: "insensitive" } } },
            { episodio: { folio: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };
  const planes = await prisma.hospPlanTratamiento.findMany({ where, include: incluyePlan, orderBy: { createdAt: "desc" }, take: 300 });
  const hoy = new Date();
  return NextResponse.json(planes.map((p) => serializarPlan(p, hoy)));
});

const createSchema = planCamposSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);

  const plan = await crearPlan(prisma, { ...d, usuario: usuarioDe(user) });

  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.plan.crear",
    entidad: "HospPlanTratamiento",
    entidadId: plan.id,
    detalle: { nombre: plan.nombre, pacienteId: plan.pacienteId, protocoloId: plan.protocoloId, pagadorId: plan.pagadorId, total: Number(plan.total) },
  });
  return NextResponse.json(serializarPlan(plan), { status: 201 });
});
