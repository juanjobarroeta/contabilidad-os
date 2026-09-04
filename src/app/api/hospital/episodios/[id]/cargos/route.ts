/**
 * POST /api/hospital/episodios/[id]/cargos — cargo manual a la cuenta.
 *
 * Con `servicioId` el precio sale del tarifario del pagador del episodio (o
 * del precio de lista) y la categoría/descripción/IVA del catálogo, salvo que
 * el body los traiga. Sin servicio, hay que capturarlo todo. Un HONORARIO sin
 * `medicoId` se cuelga del médico tratante del episodio.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { HospCargoCategoria } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, dinero, error, errorZod, fechaSchema, tasaIva } from "@/lib/hospital/http";
import { calcularRenglon } from "@/lib/hospital/cuenta";
import { ivaDefault, r2 } from "@/lib/hospital/util";

const CATEGORIAS = ["HABITACION", "QUIROFANO", "URGENCIAS", "ESTUDIO", "PROCEDIMIENTO", "HONORARIO", "FARMACIA", "MATERIAL", "EQUIPO", "OTRO"] as const;

const schema = z.object({
  categoria: z.enum(CATEGORIAS).optional(),
  descripcion: z.string().min(1).max(300).optional(),
  cantidad: z.number().positive().max(100000).default(1),
  precioUnitario: dinero.optional(),
  ivaTasa: tasaIva.optional(),
  servicioId: z.string().nullable().optional(),
  medicoId: z.string().nullable().optional(),
  loteId: z.string().nullable().optional(),
  fecha: fechaSchema.nullable().optional(),
});

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, estado: true, folio: true, pagadorId: true, medicoId: true } });
  if (!ep) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(ep.companyId, req);
  await requireModule(ep.companyId, "HOSPITAL", req);
  if (ep.estado === "CANCELADO") return error(`El episodio ${ep.folio} está cancelado`, 409);

  let categoria: HospCargoCategoria | undefined = d.categoria;
  let descripcion = d.descripcion?.trim();
  let precioUnitario = d.precioUnitario;
  let ivaTasa: number | null | undefined = d.ivaTasa;

  if (d.servicioId) {
    const servicio = await prisma.hospServicio.findUnique({
      where: { id: d.servicioId },
      include: { tarifas: ep.pagadorId ? { where: { pagadorId: ep.pagadorId } } : false },
    });
    if (!servicio || servicio.companyId !== ep.companyId) return error("servicioId inválido");
    categoria ??= servicio.categoria;
    descripcion ||= servicio.nombre;
    const tarifa = Array.isArray(servicio.tarifas) ? servicio.tarifas[0] : null;
    precioUnitario ??= r2(Number(tarifa?.precio ?? servicio.precioLista));
    if (ivaTasa === undefined) ivaTasa = servicio.ivaTasa == null ? null : Number(servicio.ivaTasa);
  }
  if (!categoria || !descripcion || precioUnitario == null) {
    return error("Sin servicioId hay que capturar categoria, descripcion y precioUnitario");
  }
  if (ivaTasa === undefined) {
    const cfg = await prisma.hospConfig.findUnique({ where: { companyId: ep.companyId }, select: { ivaServicios: true } });
    ivaTasa = ivaDefault(categoria, cfg ? Number(cfg.ivaServicios) : null);
  }

  const medicoId = d.medicoId === undefined ? (categoria === "HONORARIO" ? ep.medicoId : null) : d.medicoId;
  if (medicoId) {
    const m = await prisma.hospMedico.findUnique({ where: { id: medicoId }, select: { companyId: true } });
    if (!m || m.companyId !== ep.companyId) return error("medicoId inválido");
  }
  if (d.loteId) {
    const l = await prisma.hospLote.findUnique({ where: { id: d.loteId }, select: { companyId: true } });
    if (!l || l.companyId !== ep.companyId) return error("loteId inválido");
  }

  const cargo = await prisma.hospCargo.create({
    data: {
      companyId: ep.companyId,
      episodioId: ep.id,
      fecha: aFecha(d.fecha) ?? new Date(),
      categoria,
      descripcion,
      cantidad: d.cantidad,
      precioUnitario,
      ivaTasa,
      importe: r2(d.cantidad * precioUnitario),
      origen: "MANUAL",
      servicioId: d.servicioId ?? null,
      medicoId,
      loteId: d.loteId ?? null,
      creadoPorUserId: user.id,
    },
    include: { lote: { select: { lote: true } }, medico: { select: { id: true, nombre: true } } },
  });

  bitacora(user, req, {
    companyId: ep.companyId,
    accion: "hospital.cargo.crear",
    entidad: "HospCargo",
    entidadId: cargo.id,
    detalle: { folio: ep.folio, categoria, descripcion, cantidad: d.cantidad, precioUnitario, importe: Number(cargo.importe) },
  });

  return NextResponse.json(
    { ...cargo, ...calcularRenglon({ ...cargo, cantidad: Number(cargo.cantidad), precioUnitario: Number(cargo.precioUnitario), ivaTasa: cargo.ivaTasa == null ? null : Number(cargo.ivaTasa), importe: Number(cargo.importe) }) },
    { status: 201 }
  );
});
