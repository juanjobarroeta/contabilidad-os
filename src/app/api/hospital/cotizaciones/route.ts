/**
 * GET  /api/hospital/cotizaciones?companyId=…[&estado=&q=&medicoId=&pacienteId=]
 * POST /api/hospital/cotizaciones
 *
 * «Una captura, tres documentos» (lámina 7): la cotización se arma con el
 * tarifario del pagador (precio por partida desde HospTarifa o lista), los
 * totales los calcula el servidor, y al ingresar se convierte en la cuenta.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospCotizacionEstado, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { conFolioUnico, siguienteFolio } from "@/lib/hospital/folio";
import { datosDeVersion, fotoDeProtocolo } from "@/lib/hospital/cotizacion-historial-db";
import { aPaquete, armarPartidas, incluyeCotizacion, partidaSchema, serializarCotizacion } from "@/lib/hospital/cotizacion";
import { pacienteResumen } from "@/lib/hospital/serializar";
import { nombreCompleto } from "@/lib/hospital/util";
import { resolverAltasCita } from "@/lib/hospital/cita-altas";
import { HospitalError } from "@/lib/hospital/errores";
import { DIAS_PRIMER_SEGUIMIENTO, ORIGENES_COTIZACION } from "@/lib/hospital/cotizacion-crm";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const estado = searchParams.get("estado") as HospCotizacionEstado | null;
  const q = searchParams.get("q")?.trim();
  // Desde la agenda: las del médico o las del paciente de la cita.
  const medicoId = searchParams.get("medicoId");
  const pacienteId = searchParams.get("pacienteId");
  const de = [medicoId ? { medicoId } : null, pacienteId ? { pacienteId } : null].filter((x) => x !== null);
  const where: Prisma.HospCotizacionWhereInput = {
    companyId,
    ...(estado ? { estado } : {}),
    ...(de.length ? { AND: [{ OR: de }] } : {}),
    ...(q ? { OR: [{ folio: { contains: q, mode: "insensitive" } }, { pacienteNombre: { contains: q, mode: "insensitive" } }, { medico: { nombre: { contains: q, mode: "insensitive" } } }, { procedimiento: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const cotizaciones = await prisma.hospCotizacion.findMany({
    where,
    include: { ...incluyeCotizacion, _count: { select: { partidas: true } } },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  return NextResponse.json(
    cotizaciones.map(({ _count, paciente, ...c }) => ({
      ...serializarCotizacion(c),
      paciente: paciente ? pacienteResumen(paciente) : null,
      numPartidas: _count.partidas,
    }))
  );
});

const createSchema = z.object({
  companyId: z.string().min(1),
  pacienteId: z.string().nullable().optional(),
  pacienteNombre: z.string().max(200).nullable().optional(),
  pagadorId: z.string().nullable().optional(),
  medicoId: z.string().nullable().optional(),
  /** Médico escrito libre: se da de alta por credencializar (mismo trato que en la agenda). */
  medicoNuevo: z.object({ nombre: z.string().trim().min(3).max(200) }).optional(),
  dirigidaA: z.string().max(200).nullable().optional(),
  precioPaquete: z.number().positive().max(100_000_000).nullable().optional(),
  procedimiento: z.string().min(1).max(300),
  vigenciaHasta: fechaSchema.nullable().optional(),
  notas: z.string().max(4000).nullable().optional(),
  estado: z.enum(["BORRADOR", "ENVIADA"]).optional(),
  partidas: z.array(partidaSchema).min(1).max(200),
  // Seguimiento: quién la trabaja y cómo localizar a quien la pidió.
  contactoNombre: z.string().trim().max(200).nullable().optional(),
  contactoTelefono: z.string().trim().max(40).nullable().optional(),
  contactoEmail: z.string().trim().email().max(200).nullable().optional().or(z.literal("").transform(() => null)),
  origen: z.enum(ORIGENES_COTIZACION).nullable().optional(),
  responsableUserId: z.string().nullable().optional(),
  /** Protocolo/paquete del que nace: se congela su foto para medir después cuánto se descontó y dónde. */
  protocoloId: z.string().nullable().optional(),
  /** Por qué se movió respecto de la plantilla (interno, no sale en el PDF). */
  motivo: z.string().trim().max(1000).nullable().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);

  let pacienteNombre = d.pacienteNombre?.trim() || null;
  if (d.pacienteId) {
    const p = await prisma.hospPaciente.findUnique({ where: { id: d.pacienteId }, select: { companyId: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true } });
    if (!p || p.companyId !== d.companyId) return error("pacienteId inválido");
    pacienteNombre ??= nombreCompleto(p);
  }
  // Una cotización para un médico puede no tener paciente todavía.
  if (!pacienteNombre && !d.medicoId && !d.medicoNuevo) return error("pacienteId, pacienteNombre o medicoId requerido");
  if (d.medicoId) {
    const m = await prisma.hospMedico.findUnique({ where: { id: d.medicoId }, select: { companyId: true } });
    if (!m || m.companyId !== d.companyId) return error("medicoId inválido");
  }
  if (d.pagadorId) {
    const p = await prisma.hospPagador.findUnique({ where: { id: d.pagadorId }, select: { companyId: true } });
    if (!p || p.companyId !== d.companyId) return error("pagadorId inválido");
  }
  if (d.responsableUserId && d.responsableUserId !== user.id) {
    const m = await prisma.companyMember.findUnique({ where: { userId_companyId: { userId: d.responsableUserId, companyId: d.companyId } }, select: { id: true } });
    if (!m) return error("El responsable no es usuario de este hospital");
  }
  const estadoInicial = d.estado ?? "BORRADOR";

  const lista = await armarPartidas(prisma, d.companyId, d.pagadorId, d.partidas);
  const armado = d.precioPaquete ? aPaquete(lista, d.precioPaquete) : lista;
  const hoy = new Date();
  // Historia: la foto del protocolo de origen (si nace de uno) y la versión 1.
  const origen = d.protocoloId ? await fotoDeProtocolo(prisma, d.companyId, d.protocoloId, d.pagadorId) : null;
  const version1 = await datosDeVersion(prisma, d.companyId, 1, lista, armado, d.precioPaquete ?? null, user, d.motivo);

  const cotizacion = await conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, d.companyId, "cotizacion", hoy);
      const altas = d.medicoNuevo && !d.medicoId ? await resolverAltasCita(tx, d.companyId, { medicoNuevo: d.medicoNuevo }, hoy) : null;
      if (altas && altas.error !== null) throw new HospitalError(400, altas.error);
      const medicoId = d.medicoId ?? altas?.medicoId ?? null;
      return tx.hospCotizacion.create({
        data: {
          companyId: d.companyId,
          folio,
          pacienteId: d.pacienteId ?? null,
          pacienteNombre: pacienteNombre ?? "",
          pagadorId: d.pagadorId ?? null,
          medicoId,
          dirigidaA: d.dirigidaA?.trim() || null,
          precioPaquete: d.precioPaquete ?? null,
          procedimiento: d.procedimiento.trim(),
          estado: estadoInicial,
          // Quien la captura le da seguimiento salvo que se diga otro.
          responsableUserId: d.responsableUserId ?? user.id,
          contactoNombre: d.contactoNombre?.trim() || null,
          contactoTelefono: d.contactoTelefono?.trim() || null,
          contactoEmail: d.contactoEmail || null,
          origen: d.origen ?? (medicoId ? "MEDICO" : null),
          ...(estadoInicial === "ENVIADA" ? { enviadaAt: hoy, proximoSeguimiento: new Date(hoy.getTime() + DIAS_PRIMER_SEGUIMIENTO * 86_400_000) } : {}),
          vigenciaHasta: aFecha(d.vigenciaHasta),
          subtotal: armado.subtotal,
          iva: armado.iva,
          total: armado.total,
          notas: d.notas?.trim() || null,
          creadoPorUserId: user.id,
          partidas: { create: armado.partidas },
          ...(origen ? { origenPaquete: { create: origen } } : {}),
          versiones: { create: version1 },
        },
        include: incluyeCotizacion,
      });
    })
  );

  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.cotizacion.crear",
    entidad: "HospCotizacion",
    entidadId: cotizacion.id,
    detalle: { folio: cotizacion.folio, paciente: pacienteNombre, medicoId: cotizacion.medicoId, medicoNuevo: d.medicoNuevo?.nombre ?? null, paquete: d.precioPaquete ?? null, procedimiento: cotizacion.procedimiento, total: armado.total, partidas: armado.partidas.length },
  });
  return NextResponse.json({ ...serializarCotizacion(cotizacion), paciente: cotizacion.paciente ? pacienteResumen(cotizacion.paciente) : null }, { status: 201 });
});
