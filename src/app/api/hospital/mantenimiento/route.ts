/**
 * GET  /api/hospital/mantenimiento?companyId=…[&estado=ABIERTOS|CERRADOS|TODOS|<estado>]
 * POST /api/hospital/mantenimiento — ticket con folio MANT-; reportadoPor = el usuario.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospTicketEstado, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { conFolioUnico, siguienteFolio } from "@/lib/hospital/folio";
import { nombreCompleto } from "@/lib/hospital/util";

const ESTADOS = ["ABIERTO", "ASIGNADO", "EN_PROCESO", "CERRADO", "CANCELADO"] as const;

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const estado = (searchParams.get("estado") ?? "ABIERTOS").toUpperCase();
  const where: Prisma.HospTicketWhereInput = {
    companyId,
    ...(estado === "ABIERTOS"
      ? { estado: { in: ["ABIERTO", "ASIGNADO", "EN_PROCESO"] } }
      : estado === "CERRADOS"
        ? { estado: { in: ["CERRADO", "CANCELADO"] } }
        : estado === "TODOS"
          ? {}
          : (ESTADOS as readonly string[]).includes(estado)
            ? { estado: estado as HospTicketEstado }
            : {}),
  };
  const tickets = await prisma.hospTicket.findMany({
    where,
    orderBy: [{ estado: "asc" }, { prioridad: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
  return NextResponse.json(tickets);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  titulo: z.string().min(1).max(200),
  descripcion: z.string().max(4000).nullable().optional(),
  area: z.enum(["HOSPITALIZACION", "URGENCIAS", "RECUPERACION", "TERAPIA", "QUIROFANO", "CONSULTA_EXTERNA", "ENDOSCOPIA", "IMAGEN", "LABORATORIO", "OTRA"]).nullable().optional(),
  equipo: z.string().max(120).nullable().optional(),
  /** Dónde está la falla: la cama, el quirófano, la sala. No son coordenadas
   *  — un hospital es un edificio y el GPS no distingue un quirófano del de
   *  al lado; el recurso sí es lo que el técnico va a atender. */
  recursoId: z.string().nullable().optional(),
  prioridad: z.enum(["BAJA", "MEDIA", "ALTA", "URGENTE"]).optional(),
  preventivo: z.boolean().optional(),
  programadoPara: fechaSchema.nullable().optional(),
  asignadoEmployeeId: z.string().nullable().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, programadoPara, asignadoEmployeeId, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  let asignadoA: string | null = null;
  if (asignadoEmployeeId) {
    const e = await prisma.employee.findUnique({ where: { id: asignadoEmployeeId }, select: { companyId: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true } });
    if (!e || e.companyId !== companyId) return error("asignadoEmployeeId inválido");
    asignadoA = nombreCompleto(e);
  }

  // El recurso tiene que ser de esta empresa: si no, un id ajeno colgaría la
  // falla del quirófano de otro hospital.
  if (d.recursoId) {
    const r = await prisma.hospRecurso.findUnique({ where: { id: d.recursoId }, select: { companyId: true } });
    if (!r || r.companyId !== companyId) return error("recursoId inválido");
  }

  const usuario = usuarioDe(user);
  const hoy = new Date();
  const ticket = await conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, companyId, "ticket", hoy);
      return tx.hospTicket.create({
        data: {
          companyId,
          folio,
          ...d,
          titulo: d.titulo.trim(),
          descripcion: d.descripcion?.trim() || null,
          estado: asignadoEmployeeId ? "ASIGNADO" : "ABIERTO",
          reportadoPorUserId: usuario.id,
          reportadoPor: usuario.nombre,
          asignadoEmployeeId: asignadoEmployeeId ?? null,
          asignadoA,
          programadoPara: aFecha(programadoPara),
        },
      });
    })
  );

  bitacora(user, req, { companyId, accion: "hospital.ticket.crear", entidad: "HospTicket", entidadId: ticket.id, detalle: { folio: ticket.folio, titulo: ticket.titulo, prioridad: ticket.prioridad, estado: ticket.estado } });
  return NextResponse.json(ticket, { status: 201 });
});
