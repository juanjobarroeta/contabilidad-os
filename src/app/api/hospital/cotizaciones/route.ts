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
import { aPaquete, armarPartidas, incluyeCotizacion, partidaSchema, serializarCotizacion } from "@/lib/hospital/cotizacion";
import { pacienteResumen } from "@/lib/hospital/serializar";
import { nombreCompleto } from "@/lib/hospital/util";
import { resolverAltasCita } from "@/lib/hospital/cita-altas";
import { HospitalError } from "@/lib/hospital/errores";

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

  const lista = await armarPartidas(prisma, d.companyId, d.pagadorId, d.partidas);
  const armado = d.precioPaquete ? aPaquete(lista, d.precioPaquete) : lista;
  const hoy = new Date();

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
          estado: d.estado ?? "BORRADOR",
          vigenciaHasta: aFecha(d.vigenciaHasta),
          subtotal: armado.subtotal,
          iva: armado.iva,
          total: armado.total,
          notas: d.notas?.trim() || null,
          creadoPorUserId: user.id,
          partidas: { create: armado.partidas },
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
