/**
 * PATCH /api/hospital/mantenimiento/[id] — estado (con transiciones),
 * responsable (asignadoEmployeeId → asignadoA desde Employee), fecha
 * programada, resolución (CERRADO fija cerradoAt), prioridad y datos.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospTicketEstado } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { nombreCompleto } from "@/lib/hospital/util";

const TRANSICIONES: Record<HospTicketEstado, HospTicketEstado[]> = {
  ABIERTO: ["ASIGNADO", "EN_PROCESO", "CANCELADO"],
  ASIGNADO: ["EN_PROCESO", "CERRADO", "CANCELADO", "ABIERTO"],
  EN_PROCESO: ["CERRADO", "CANCELADO", "ASIGNADO"],
  CERRADO: ["EN_PROCESO"],
  CANCELADO: ["ABIERTO"],
};

const schema = z.object({
  estado: z.enum(["ABIERTO", "ASIGNADO", "EN_PROCESO", "CERRADO", "CANCELADO"]).optional(),
  asignadoEmployeeId: z.string().nullable().optional(),
  asignadoA: z.string().max(120).nullable().optional(),
  programadoPara: fechaSchema.nullable().optional(),
  resolucion: z.string().max(4000).nullable().optional(),
  prioridad: z.enum(["BAJA", "MEDIA", "ALTA", "URGENTE"]).optional(),
  titulo: z.string().min(1).max(200).optional(),
  descripcion: z.string().max(4000).nullable().optional(),
  area: z.enum(["HOSPITALIZACION", "URGENCIAS", "RECUPERACION", "TERAPIA", "QUIROFANO", "CONSULTA_EXTERNA", "ENDOSCOPIA", "IMAGEN", "LABORATORIO", "OTRA"]).nullable().optional(),
  equipo: z.string().max(120).nullable().optional(),
  preventivo: z.boolean().optional(),
});

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ticket = await prisma.hospTicket.findUnique({ where: { id } });
  if (!ticket) throw new AuthzError(404, "Ticket no encontrado");

  const { user } = await requireWriter(ticket.companyId, req);
  await requireModule(ticket.companyId, "HOSPITAL", req);

  // Responsable: el nombre se congela desde Employee al asignar.
  let asignado: { asignadoEmployeeId: string | null; asignadoA: string | null } | null = null;
  if (d.asignadoEmployeeId !== undefined) {
    if (d.asignadoEmployeeId) {
      const e = await prisma.employee.findUnique({ where: { id: d.asignadoEmployeeId }, select: { companyId: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true } });
      if (!e || e.companyId !== ticket.companyId) return error("asignadoEmployeeId inválido");
      asignado = { asignadoEmployeeId: d.asignadoEmployeeId, asignadoA: d.asignadoA?.trim() || nombreCompleto(e) };
    } else {
      asignado = { asignadoEmployeeId: null, asignadoA: d.asignadoA?.trim() || null };
    }
  } else if (d.asignadoA !== undefined) {
    asignado = { asignadoEmployeeId: ticket.asignadoEmployeeId, asignadoA: d.asignadoA?.trim() || null };
  }

  // Estado: el que pide el body; si sólo asignan a alguien a un ticket ABIERTO, pasa a ASIGNADO.
  let estado = d.estado;
  if (!estado && asignado?.asignadoEmployeeId && ticket.estado === "ABIERTO") estado = "ASIGNADO";
  if (estado && estado !== ticket.estado && !TRANSICIONES[ticket.estado].includes(estado)) {
    return error(`De ${ticket.estado} no se pasa a ${estado} (permitido: ${TRANSICIONES[ticket.estado].join(", ")})`, 409);
  }
  if (estado === "CERRADO" && !(d.resolucion?.trim() || ticket.resolucion)) return error("Para cerrar el ticket captura la resolución");

  const actualizado = await prisma.hospTicket.update({
    where: { id },
    data: {
      ...(estado ? { estado } : {}),
      ...(asignado ?? {}),
      ...(d.programadoPara !== undefined ? { programadoPara: aFecha(d.programadoPara) } : {}),
      ...(d.resolucion !== undefined ? { resolucion: d.resolucion?.trim() || null } : {}),
      ...(d.prioridad ? { prioridad: d.prioridad } : {}),
      ...(d.titulo ? { titulo: d.titulo.trim() } : {}),
      ...(d.descripcion !== undefined ? { descripcion: d.descripcion?.trim() || null } : {}),
      ...(d.area !== undefined ? { area: d.area } : {}),
      ...(d.equipo !== undefined ? { equipo: d.equipo?.trim() || null } : {}),
      ...(d.preventivo !== undefined ? { preventivo: d.preventivo } : {}),
      ...(estado === "CERRADO" ? { cerradoAt: new Date() } : estado && ticket.estado === "CERRADO" ? { cerradoAt: null } : {}),
    },
  });

  bitacora(user, req, {
    companyId: ticket.companyId,
    accion: "hospital.ticket.editar",
    entidad: "HospTicket",
    entidadId: id,
    detalle: { folio: ticket.folio, cambios: Object.keys(d), estadoAntes: ticket.estado, estadoDespues: actualizado.estado, asignadoA: actualizado.asignadoA },
  });
  return NextResponse.json(actualizado);
});
