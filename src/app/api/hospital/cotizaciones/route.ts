/**
 * GET  /api/hospital/cotizaciones?companyId=…[&estado=&q=]
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
import { armarPartidas, incluyeCotizacion, partidaSchema, serializarCotizacion } from "@/lib/hospital/cotizacion";
import { pacienteResumen } from "@/lib/hospital/serializar";
import { nombreCompleto } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const estado = searchParams.get("estado") as HospCotizacionEstado | null;
  const q = searchParams.get("q")?.trim();
  const where: Prisma.HospCotizacionWhereInput = {
    companyId,
    ...(estado ? { estado } : {}),
    ...(q ? { OR: [{ folio: { contains: q, mode: "insensitive" } }, { pacienteNombre: { contains: q, mode: "insensitive" } }, { procedimiento: { contains: q, mode: "insensitive" } }] } : {}),
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
  if (!pacienteNombre) return error("pacienteId o pacienteNombre requerido");
  if (d.pagadorId) {
    const p = await prisma.hospPagador.findUnique({ where: { id: d.pagadorId }, select: { companyId: true } });
    if (!p || p.companyId !== d.companyId) return error("pagadorId inválido");
  }

  const armado = await armarPartidas(prisma, d.companyId, d.pagadorId, d.partidas);
  const hoy = new Date();

  const cotizacion = await conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const folio = await siguienteFolio(tx, d.companyId, "cotizacion", hoy);
      return tx.hospCotizacion.create({
        data: {
          companyId: d.companyId,
          folio,
          pacienteId: d.pacienteId ?? null,
          pacienteNombre: pacienteNombre!,
          pagadorId: d.pagadorId ?? null,
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
    detalle: { folio: cotizacion.folio, paciente: pacienteNombre, procedimiento: cotizacion.procedimiento, total: armado.total, partidas: armado.partidas.length },
  });
  return NextResponse.json({ ...serializarCotizacion(cotizacion), paciente: cotizacion.paciente ? pacienteResumen(cotizacion.paciente) : null }, { status: 201 });
});
