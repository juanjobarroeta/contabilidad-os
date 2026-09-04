/**
 * GET  /api/hospital/medicos?companyId=…[&todos=1]
 * POST /api/hospital/medicos
 *
 * Médicos tratantes con sus episodios activos y los honorarios cargados en
 * el mes en curso (Σ cargos HONORARIO vivos).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { partesLocales, rangoMesLocal } from "@/lib/hospital/tz";
import { ESTADOS_ACTIVOS, r2 } from "@/lib/hospital/util";
import { medicoSchema } from "@/lib/hospital/medico-schema";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const todos = searchParams.get("todos") === "1";
  const hoy = new Date();
  const { y, m } = partesLocales(hoy);
  const mes = rangoMesLocal(y, m);

  const [medicos, honorarios] = await Promise.all([
    prisma.hospMedico.findMany({
      where: { companyId, ...(todos ? {} : { activo: true }) },
      include: {
        supplier: { select: { id: true, razonSocial: true, rfc: true } },
        employee: { select: { id: true, nombre: true, apellidoPaterno: true } },
        _count: { select: { episodios: { where: { estado: { in: ESTADOS_ACTIVOS } } } } },
      },
      orderBy: { nombre: "asc" },
    }),
    prisma.hospCargo.groupBy({
      by: ["medicoId"],
      where: { companyId, categoria: "HONORARIO", cancelado: false, medicoId: { not: null }, fecha: { gte: mes.desde, lt: mes.hasta } },
      _sum: { importe: true },
    }),
  ]);
  const porMedico = new Map(honorarios.map((h) => [h.medicoId, Number(h._sum.importe ?? 0)]));

  return NextResponse.json(
    medicos.map(({ _count, ...m }) => ({
      ...m,
      episodiosActivos: _count.episodios,
      honorariosMes: r2(porMedico.get(m.id) ?? 0),
    }))
  );
});

const createSchema = medicoSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  if (d.supplierId) {
    const s = await prisma.supplier.findUnique({ where: { id: d.supplierId }, select: { companyId: true } });
    if (!s || s.companyId !== companyId) return error("supplierId inválido");
  }
  if (d.employeeId) {
    const e = await prisma.employee.findUnique({ where: { id: d.employeeId }, select: { companyId: true } });
    if (!e || e.companyId !== companyId) return error("employeeId inválido");
  }

  const medico = await prisma.hospMedico.create({ data: { companyId, ...d, nombre: d.nombre.trim(), rfc: d.rfc?.trim().toUpperCase() || null } });
  bitacora(user, req, { companyId, accion: "hospital.medico.crear", entidad: "HospMedico", entidadId: medico.id, detalle: { nombre: medico.nombre, especialidad: medico.especialidad } });
  return NextResponse.json({ ...medico, episodiosActivos: 0, honorariosMes: 0 }, { status: 201 });
});
