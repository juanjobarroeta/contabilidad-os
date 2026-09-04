/**
 * GET  /api/hospital/recursos?companyId=…[&tipo=CAMA&todos=1]
 * POST /api/hospital/recursos
 *
 * Camas, quirófanos, consultorios y salas. Las camas traen su episodio
 * activo; el `servicio` es la tarifa que se carga sola (noche / hora).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospRecursoTipo } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { ESTADOS_ACTIVOS, nombreCompleto } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const tipo = searchParams.get("tipo") as HospRecursoTipo | null;
  const todos = searchParams.get("todos") === "1";

  const recursos = await prisma.hospRecurso.findMany({
    where: { companyId, ...(tipo ? { tipo } : {}), ...(todos ? {} : { activo: true }) },
    include: {
      servicio: { select: { id: true, clave: true, nombre: true, unidad: true, precioLista: true, ivaTasa: true } },
      episodios: {
        where: { estado: { in: ESTADOS_ACTIVOS } },
        take: 1,
        select: { id: true, folio: true, estado: true, fechaIngreso: true, paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } } },
      },
    },
    orderBy: [{ tipo: "asc" }, { orden: "asc" }, { nombre: "asc" }],
  });

  return NextResponse.json(
    recursos.map(({ episodios, servicio, ...r }) => ({
      ...r,
      servicio: servicio ? { ...servicio, precioLista: Number(servicio.precioLista), ivaTasa: servicio.ivaTasa == null ? null : Number(servicio.ivaTasa) } : null,
      episodio: episodios[0] ? { id: episodios[0].id, folio: episodios[0].folio, estado: episodios[0].estado, fechaIngreso: episodios[0].fechaIngreso, paciente: nombreCompleto(episodios[0].paciente) } : null,
    }))
  );
});

const createSchema = z.object({
  companyId: z.string().min(1),
  tipo: z.enum(["CAMA", "QUIROFANO", "CONSULTORIO", "SALA"]),
  area: z.enum(["HOSPITALIZACION", "URGENCIAS", "RECUPERACION", "TERAPIA", "QUIROFANO", "CONSULTA_EXTERNA", "ENDOSCOPIA", "IMAGEN", "LABORATORIO", "OTRA"]),
  nombre: z.string().min(1).max(60),
  servicioId: z.string().nullable().optional(),
  orden: z.number().int().min(0).max(10000).optional(),
  estado: z.enum(["LIBRE", "LIMPIEZA", "FUERA_DE_SERVICIO"]).optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  if (d.servicioId) {
    const s = await prisma.hospServicio.findUnique({ where: { id: d.servicioId }, select: { companyId: true } });
    if (!s || s.companyId !== companyId) return error("servicioId inválido");
  }
  const nombre = d.nombre.trim();
  const dup = await prisma.hospRecurso.findUnique({ where: { companyId_tipo_nombre: { companyId, tipo: d.tipo, nombre } }, select: { id: true } });
  if (dup) return error(`Ya existe ${d.tipo === "CAMA" ? "la cama" : "el recurso"} «${nombre}»`, 409);

  const recurso = await prisma.hospRecurso.create({ data: { companyId, ...d, nombre } });
  bitacora(user, req, { companyId, accion: "hospital.recurso.crear", entidad: "HospRecurso", entidadId: recurso.id, detalle: { tipo: d.tipo, area: d.area, nombre } });
  return NextResponse.json(recurso, { status: 201 });
});
