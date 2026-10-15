/**
 * PATCH /api/hospital/recursos/[id] — tipo, nombre, área, estado (LIMPIEZA→LIBRE,
 * FUERA_DE_SERVICIO…), servicio, activo, orden, minutos de limpieza entre
 * citas. No se pone LIBRE ni fuera de servicio una cama que un episodio
 * activo ocupa (409): eso lo hace el alta.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { ESTADOS_ACTIVOS } from "@/lib/hospital/util";

const schema = z.object({
  /** Cambiar de tipo (una «sala» que era cama): no con paciente dentro ni con citas por venir. */
  tipo: z.enum(["CAMA", "QUIROFANO", "CONSULTORIO", "SALA"]).optional(),
  nombre: z.string().min(1).max(60).optional(),
  area: z.enum(["HOSPITALIZACION", "URGENCIAS", "RECUPERACION", "TERAPIA", "QUIROFANO", "CONSULTA_EXTERNA", "ENDOSCOPIA", "IMAGEN", "LABORATORIO", "OTRA"]).optional(),
  estado: z.enum(["LIBRE", "LIMPIEZA", "FUERA_DE_SERVICIO"]).optional(),
  servicioId: z.string().nullable().optional(),
  activo: z.boolean().optional(),
  orden: z.number().int().min(0).max(10000).optional(),
  minutosLimpieza: z.number().int().min(0).max(240).optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const recurso = await prisma.hospRecurso.findUnique({
    where: { id },
    include: { episodios: { where: { estado: { in: ESTADOS_ACTIVOS } }, select: { id: true, folio: true } } },
  });
  if (!recurso) throw new AuthzError(404, "Recurso no encontrado");

  const { user } = await requireWriter(recurso.companyId, req);
  await requireModule(recurso.companyId, "HOSPITAL", req);

  const ocupante = recurso.episodios[0];
  if ((d.estado || d.activo === false) && ocupante) {
    return error(`${recurso.nombre} la ocupa el episodio ${ocupante.folio}: libérala con el alta o un traslado`, 409);
  }
  const cambiaTipo = d.tipo !== undefined && d.tipo !== recurso.tipo;
  if (cambiaTipo) {
    if (ocupante) return error(`${recurso.nombre} la ocupa el episodio ${ocupante.folio}: no se cambia de tipo con paciente`, 409);
    const citas = await prisma.hospCita.count({ where: { OR: [{ recursoId: id }, { camaId: id }], inicio: { gte: new Date() }, estado: { in: ["SOLICITADA", "PROGRAMADA", "CONFIRMADA", "EN_CURSO"] } } });
    if (citas) return error(`${recurso.nombre} tiene ${citas} cita(s) por venir: reprográmalas antes de cambiarlo de tipo`, 409);
  }
  if (d.servicioId) {
    const s = await prisma.hospServicio.findUnique({ where: { id: d.servicioId }, select: { companyId: true } });
    if (!s || s.companyId !== recurso.companyId) return error("servicioId inválido");
  }
  const nombreFinal = d.nombre?.trim() || recurso.nombre;
  if (nombreFinal !== recurso.nombre || cambiaTipo) {
    const dup = await prisma.hospRecurso.findUnique({
      where: { companyId_tipo_nombre: { companyId: recurso.companyId, tipo: d.tipo ?? recurso.tipo, nombre: nombreFinal } },
      select: { id: true },
    });
    if (dup && dup.id !== id) return error(`Ya existe «${nombreFinal}»`, 409);
  }

  const actualizado = await prisma.hospRecurso.update({
    where: { id },
    data: { ...d, ...(d.nombre ? { nombre: d.nombre.trim() } : {}) },
    include: { servicio: { select: { id: true, nombre: true } } },
  });

  bitacora(user, req, {
    companyId: recurso.companyId,
    accion: "hospital.recurso.editar",
    entidad: "HospRecurso",
    entidadId: id,
    detalle: { nombre: recurso.nombre, cambios: Object.keys(d), estadoAntes: recurso.estado, estadoDespues: actualizado.estado },
  });
  return NextResponse.json(actualizado);
});
