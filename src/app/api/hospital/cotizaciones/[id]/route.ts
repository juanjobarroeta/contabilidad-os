/**
 * GET   /api/hospital/cotizaciones/[id]
 * PATCH /api/hospital/cotizaciones/[id]
 *   { action: "estado", estado, motivoPerdida?, perdidaContra? }  BORRADOR → ENVIADA → ACEPTADA; CANCELADA / VENCIDA / PERDIDA (con motivo)
 *                                         enviar pone `enviadaAt` y, si no hay, el primer seguimiento a 2 días; aceptar o perder pone `cerradaAt`.
 *                                         Cada cambio queda en la bitácora comercial (HospCotizacionSeguimiento tipo ESTADO).
 *   { action: "partidas", partidas: [] }  reemplaza las partidas y recalcula (sólo BORRADOR/ENVIADA)
 *   { action: "datos", … }                procedimiento, vigencia, notas, pagador (no re-precia); seguimiento: responsable, próximo seguimiento, contacto, origen
 * CONVERTIDA sólo la pone POST …/convertir.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospCotizacionEstado } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { aPaquete, armarPartidas, incluyeCotizacion, partidaSchema, serializarCotizacion } from "@/lib/hospital/cotizacion";
import { pacienteResumen } from "@/lib/hospital/serializar";
import { DIAS_PRIMER_SEGUIMIENTO, MOTIVOS_PERDIDA, ORIGENES_COTIZACION } from "@/lib/hospital/cotizacion-crm";

type Ctx = { params: Promise<{ id: string }> };

const TRANSICIONES: Record<HospCotizacionEstado, HospCotizacionEstado[]> = {
  BORRADOR: ["ENVIADA", "ACEPTADA", "CANCELADA", "PERDIDA"],
  ENVIADA: ["ACEPTADA", "BORRADOR", "CANCELADA", "VENCIDA", "PERDIDA"],
  ACEPTADA: ["CANCELADA", "VENCIDA", "PERDIDA"],
  VENCIDA: ["ENVIADA", "CANCELADA", "PERDIDA"],
  CONVERTIDA: [],
  CANCELADA: ["BORRADOR"],
  // Reabrir: el paciente regresó.
  PERDIDA: ["ENVIADA"],
};

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const c = await prisma.hospCotizacion.findUnique({
    where: { id },
    include: {
      ...incluyeCotizacion,
      citas: { select: { id: true, titulo: true, inicio: true, fin: true, estado: true, recurso: { select: { id: true, nombre: true } } } },
      seguimientos: { orderBy: { createdAt: "desc" }, take: 200 },
    },
  });
  if (!c) throw new AuthzError(404, "Cotización no encontrada");

  await requireMembership(c.companyId, undefined, req);
  await requireModule(c.companyId, "HOSPITAL", req);

  return NextResponse.json({ ...serializarCotizacion(c), paciente: c.paciente ? pacienteResumen(c.paciente) : null });
});

const patchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("estado"),
    estado: z.enum(["BORRADOR", "ENVIADA", "ACEPTADA", "VENCIDA", "CANCELADA", "PERDIDA"]),
    motivoPerdida: z.enum(MOTIVOS_PERDIDA).optional(),
    perdidaContra: z.string().trim().max(200).nullable().optional(),
    nota: z.string().trim().max(2000).optional(),
  }),
  // precioPaquete: omitido = el que ya tenía; null = deja de ser paquete.
  z.object({ action: z.literal("partidas"), partidas: z.array(partidaSchema).min(1).max(200), precioPaquete: z.number().positive().max(100_000_000).nullable().optional() }),
  z.object({
    action: z.literal("datos"),
    procedimiento: z.string().min(1).max(300).optional(),
    vigenciaHasta: fechaSchema.nullable().optional(),
    notas: z.string().max(4000).nullable().optional(),
    pagadorId: z.string().nullable().optional(),
    pacienteId: z.string().nullable().optional(),
    pacienteNombre: z.string().max(200).optional(),
    medicoId: z.string().nullable().optional(),
    dirigidaA: z.string().max(200).nullable().optional(),
    responsableUserId: z.string().nullable().optional(),
    proximoSeguimiento: fechaSchema.nullable().optional(),
    contactoNombre: z.string().trim().max(200).nullable().optional(),
    contactoTelefono: z.string().trim().max(40).nullable().optional(),
    contactoEmail: z.string().trim().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
    origen: z.enum(ORIGENES_COTIZACION).nullable().optional(),
  }),
]);

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const c = await prisma.hospCotizacion.findUnique({
    where: { id },
    select: { id: true, companyId: true, folio: true, estado: true, pagadorId: true, total: true, precioPaquete: true, enviadaAt: true, proximoSeguimiento: true },
  });
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
    if (d.estado === "PERDIDA" && !d.motivoPerdida) return error("Para marcarla perdida di por qué (motivoPerdida)");
    const ahora = new Date();
    const cierra = d.estado === "ACEPTADA" || d.estado === "PERDIDA";
    const sale = d.estado === "PERDIDA" || d.estado === "CANCELADA" || d.estado === "ACEPTADA";
    const actualizada = await prisma.$transaction(async (tx) => {
      await tx.hospCotizacionSeguimiento.create({
        data: {
          companyId: c.companyId, cotizacionId: id, userId: user.id, userNombre: user.name ?? user.email ?? null, tipo: "ESTADO",
          resultado: d.estado,
          nota: [`${c.estado} → ${d.estado}`, d.motivoPerdida ? `motivo: ${d.motivoPerdida}` : null, d.perdidaContra ? `se fue a ${d.perdidaContra}` : null, d.nota || null].filter(Boolean).join(" · "),
        },
      });
      return tx.hospCotizacion.update({
        where: { id },
        data: {
          estado: d.estado,
          ...(d.estado === "ENVIADA" && !c.enviadaAt ? { enviadaAt: ahora } : {}),
          // Enviada sin fecha de seguimiento: la primera llamada a los 2 días.
          ...(d.estado === "ENVIADA" && !c.proximoSeguimiento ? { proximoSeguimiento: new Date(ahora.getTime() + DIAS_PRIMER_SEGUIMIENTO * 86_400_000) } : {}),
          ...(cierra ? { cerradaAt: ahora } : { cerradaAt: null }),
          ...(sale ? { proximoSeguimiento: null } : {}),
          ...(d.estado === "PERDIDA" ? { motivoPerdida: d.motivoPerdida, perdidaContra: d.perdidaContra || null } : { motivoPerdida: null, perdidaContra: null }),
        },
        include: incluyeCotizacion,
      });
    });
    registrar("hospital.cotizacion.estado", { de: c.estado, a: d.estado, motivo: d.motivoPerdida ?? null });
    return NextResponse.json(serializarCotizacion(actualizada));
  }

  if (d.action === "partidas") {
    if (c.estado !== "BORRADOR" && c.estado !== "ENVIADA") return error(`Las partidas sólo se editan en BORRADOR o ENVIADA (está ${c.estado})`, 409);
    const precioPaquete = d.precioPaquete !== undefined ? d.precioPaquete : c.precioPaquete == null ? null : Number(c.precioPaquete);
    const lista = await armarPartidas(prisma, c.companyId, c.pagadorId, d.partidas);
    const armado = precioPaquete ? aPaquete(lista, precioPaquete) : lista;
    const actualizada = await prisma.$transaction(async (tx) => {
      await tx.hospCotizacionPartida.deleteMany({ where: { cotizacionId: id } });
      return tx.hospCotizacion.update({
        where: { id },
        data: { subtotal: armado.subtotal, iva: armado.iva, total: armado.total, precioPaquete, partidas: { create: armado.partidas } },
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
  if (campos.medicoId) {
    const m = await prisma.hospMedico.findUnique({ where: { id: campos.medicoId }, select: { companyId: true } });
    if (!m || m.companyId !== c.companyId) return error("medicoId inválido");
  }
  if (campos.pacienteId) {
    const p = await prisma.hospPaciente.findUnique({ where: { id: campos.pacienteId }, select: { companyId: true } });
    if (!p || p.companyId !== c.companyId) return error("pacienteId inválido");
  }
  if (campos.responsableUserId) {
    const m = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId: campos.responsableUserId, companyId: c.companyId } }, select: { id: true } });
    if (!m) return error("El responsable no es usuario de este hospital");
  }
  const { proximoSeguimiento, ...resto } = campos;
  const actualizada = await prisma.hospCotizacion.update({
    where: { id },
    data: {
      ...Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined)),
      ...(vigenciaHasta !== undefined ? { vigenciaHasta: aFecha(vigenciaHasta) } : {}),
      ...(proximoSeguimiento !== undefined ? { proximoSeguimiento: aFecha(proximoSeguimiento) } : {}),
    },
    include: incluyeCotizacion,
  });
  registrar("hospital.cotizacion.editar", { cambios: Object.keys(campos) });
  return NextResponse.json(serializarCotizacion(actualizada));
});
