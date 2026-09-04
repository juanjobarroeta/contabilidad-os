/**
 * POST /api/hospital/episodios/[id]/notas — nota del expediente.
 *
 * Inmutable (NOM-004-SSA3-2012): no hay PATCH ni DELETE. Una corrección es
 * una nota nueva con `reemplazaId`; la anterior queda como versión superada.
 * El autor es el usuario autenticado, nunca un nombre que mande el cliente.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";

const schema = z.object({
  tipo: z.enum(["INGRESO", "EVOLUCION", "PREOPERATORIA", "POSTOPERATORIA", "ENFERMERIA", "INDICACION", "INTERCONSULTA", "PROCEDIMIENTO", "MEDICAMENTO_APLICADO", "EGRESO"]),
  texto: z.string().min(1).max(20000),
  fecha: fechaSchema.nullable().optional(),
  medicoId: z.string().nullable().optional(),
  reemplazaId: z.string().nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, folio: true, medicoId: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);

  if (d.medicoId) {
    const m = await prisma.hospMedico.findUnique({ where: { id: d.medicoId }, select: { companyId: true } });
    if (!m || m.companyId !== ep.companyId) return error("medicoId inválido");
  }
  if (d.reemplazaId) {
    const previa = await prisma.hospNota.findUnique({
      where: { id: d.reemplazaId },
      select: { episodioId: true, reemplazadaPor: { select: { id: true } } },
    });
    if (!previa || previa.episodioId !== ep.id) return error("reemplazaId no es una nota de este episodio");
    if (previa.reemplazadaPor) return error("Esa nota ya fue reemplazada por otra; corrige la versión vigente", 409);
  }

  const usuario = usuarioDe(user);
  const nota = await prisma.hospNota.create({
    data: {
      episodioId: ep.id,
      tipo: d.tipo,
      texto: d.texto.trim(),
      fecha: aFecha(d.fecha) ?? new Date(),
      autorUserId: usuario.id,
      autorNombre: usuario.nombre,
      medicoId: d.medicoId ?? null,
      reemplazaId: d.reemplazaId ?? null,
    },
    include: { medico: { select: { id: true, nombre: true, especialidad: true } } },
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.nota.crear",
    entidad: "HospNota",
    entidadId: nota.id,
    detalle: { folio: ep.folio, tipo: d.tipo, reemplazaId: d.reemplazaId ?? null },
  });

  return NextResponse.json({ ...nota, reemplazadaPor: null }, { status: 201 });
});
