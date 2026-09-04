/**
 * GET   /api/hospital/cotizaciones/[id]
 * PATCH /api/hospital/cotizaciones/[id]
 *   { action: "estado", estado }          BORRADOR → ENVIADA → ACEPTADA; CANCELADA / VENCIDA
 *   { action: "partidas", partidas: [] }  reemplaza las partidas y recalcula (sólo BORRADOR/ENVIADA)
 *   { action: "datos", … }                procedimiento, vigencia, notas, pagador (no re-precia)
 * CONVERTIDA sólo la pone POST …/convertir.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospCotizacionEstado } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { armarPartidas, incluyeCotizacion, partidaSchema, serializarCotizacion } from "@/lib/hospital/cotizacion";
import { pacienteResumen } from "@/lib/hospital/serializar";

type Ctx = { params: Promise<{ id: string }> };

const TRANSICIONES: Record<HospCotizacionEstado, HospCotizacionEstado[]> = {
  BORRADOR: ["ENVIADA", "ACEPTADA", "CANCELADA"],
  ENVIADA: ["ACEPTADA", "BORRADOR", "CANCELADA", "VENCIDA"],
  ACEPTADA: ["CANCELADA", "VENCIDA"],
  VENCIDA: ["ENVIADA", "CANCELADA"],
  CONVERTIDA: [],
  CANCELADA: ["BORRADOR"],
};

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const c = await prisma.hospCotizacion.findUnique({
    where: { id },
    include: { ...incluyeCotizacion, citas: { select: { id: true, titulo: true, inicio: true, fin: true, estado: true, recurso: { select: { id: true, nombre: true } } } } },
  });
  if (!c) throw new AuthzError(404, "Cotización no encontrada");

  await requireMembership(c.companyId, undefined, req);
  await requireModule(c.companyId, "HOSPITAL", req);

  return NextResponse.json({ ...serializarCotizacion(c), paciente: c.paciente ? pacienteResumen(c.paciente) : null });
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("estado"), estado: z.enum(["BORRADOR", "ENVIADA", "ACEPTADA", "VENCIDA", "CANCELADA"]) }),
  z.object({ action: z.literal("partidas"), partidas: z.array(partidaSchema).min(1).max(200) }),
  z.object({
    action: z.literal("datos"),
    procedimiento: z.string().min(1).max(300).optional(),
    vigenciaHasta: fechaSchema.nullable().optional(),
    notas: z.string().max(4000).nullable().optional(),
    pagadorId: z.string().nullable().optional(),
    pacienteId: z.string().nullable().optional(),
    pacienteNombre: z.string().min(1).max(200).optional(),
  }),
]);

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const c = await prisma.hospCotizacion.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, estado: true, pagadorId: true, total: true } });
  if (!c) throw new AuthzError(404, "Cotización no encontrada");

  const { user } = await requireWriter(c.companyId, req);
  await requireModule(c.companyId, "HOSPITAL", req);

  const registrar = (accion: string, detalle: Record<string, unknown>) =>
    bitacora(user, req, { companyId: c.companyId, accion, entidad: "HospCotizacion", entidadId: id, detalle: { folio: c.folio, ...detalle } });

  if (d.action === "estado") {
    if (c.estado === d.estado) return error(`La cotización ya está ${c.estado}`, 409);
    if (!TRANSICIONES[c.estado].includes(d.estado)) {
      return error(`De ${c.estado} no se pasa a ${d.estado} (permitido: ${TRANSICIONES[c.estado].join(", ") || "ninguno"})`, 409);
    }
    const actualizada = await prisma.hospCotizacion.update({ where: { id }, data: { estado: d.estado }, include: incluyeCotizacion });
    registrar("hospital.cotizacion.estado", { de: c.estado, a: d.estado });
    return NextResponse.json(serializarCotizacion(actualizada));
  }

  if (d.action === "partidas") {
    if (c.estado !== "BORRADOR" && c.estado !== "ENVIADA") return error(`Las partidas sólo se editan en BORRADOR o ENVIADA (está ${c.estado})`, 409);
    const armado = await armarPartidas(prisma, c.companyId, c.pagadorId, d.partidas);
    const actualizada = await prisma.$transaction(async (tx) => {
      await tx.hospCotizacionPartida.deleteMany({ where: { cotizacionId: id } });
      return tx.hospCotizacion.update({
        where: { id },
        data: { subtotal: armado.subtotal, iva: armado.iva, total: armado.total, partidas: { create: armado.partidas } },
        include: incluyeCotizacion,
      });
    });
    registrar("hospital.cotizacion.partidas", { totalAntes: Number(c.total), totalDespues: armado.total, partidas: armado.partidas.length });
    return NextResponse.json(serializarCotizacion(actualizada));
  }

  // datos
  if (c.estado === "CONVERTIDA") return error("Una cotización convertida ya no se edita: la cuenta vive en el episodio", 409);
  const { action: _a, vigenciaHasta, ...campos } = d;
  if (campos.pagadorId) {
    const p = await prisma.hospPagador.findUnique({ where: { id: campos.pagadorId }, select: { companyId: true } });
    if (!p || p.companyId !== c.companyId) return error("pagadorId inválido");
  }
  if (campos.pacienteId) {
    const p = await prisma.hospPaciente.findUnique({ where: { id: campos.pacienteId }, select: { companyId: true } });
    if (!p || p.companyId !== c.companyId) return error("pacienteId inválido");
  }
  const actualizada = await prisma.hospCotizacion.update({
    where: { id },
    data: {
      ...Object.fromEntries(Object.entries(campos).filter(([, v]) => v !== undefined)),
      ...(vigenciaHasta !== undefined ? { vigenciaHasta: aFecha(vigenciaHasta) } : {}),
    },
    include: incluyeCotizacion,
  });
  registrar("hospital.cotizacion.editar", { cambios: Object.keys(campos) });
  return NextResponse.json(serializarCotizacion(actualizada));
});
