/**
 * POST /api/construccion/estimaciones/create
 *
 * Creates a new estimación for a proyecto + presupuesto. Auto-assigns
 * the next estimación number (max + 1). Returns the new estimación with
 * empty partidas — the caller fills in cantidadEjecutada per partida
 * in a subsequent PATCH before timbrar.
 *
 * Body: {
 *   proyectoId: string,
 *   presupuestoId: string,
 *   periodoInicio: string (ISO),
 *   periodoFin: string (ISO),
 * }
 *
 * Guard: presupuesto must be APROBADO or EN_EJECUCION (not BORRADOR).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const createSchema = z.object({
  proyectoId: z.string().min(1),
  presupuestoId: z.string().min(1),
  periodoInicio: z.string().datetime(),
  periodoFin: z.string().datetime(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const data = parsed.data;

  const proyecto = await prisma.proyecto.findUnique({
    where: { id: data.proyectoId },
    select: { id: true, companyId: true, codigo: true, montoContratado: true },
  });
  if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");

  await requireWriter(proyecto.companyId, req);
  await requireModule(proyecto.companyId, "CONSTRUCCION");

  const presupuesto = await prisma.presupuesto.findUnique({
    where: { id: data.presupuestoId },
    select: { id: true, estado: true, proyectoId: true },
  });
  if (!presupuesto || presupuesto.proyectoId !== proyecto.id) {
    return NextResponse.json({ error: "Presupuesto inválido" }, { status: 400 });
  }
  if (!["APROBADO", "EN_EJECUCION"].includes(presupuesto.estado)) {
    return NextResponse.json(
      { error: `Solo se pueden crear estimaciones contra presupuestos APROBADOS (estado actual: ${presupuesto.estado})` },
      { status: 422 }
    );
  }

  // Auto-assign next number
  const max = await prisma.estimacion.aggregate({
    where: { proyectoId: proyecto.id },
    _max: { numero: true },
  });
  const numero = (max._max.numero ?? 0) + 1;

  const estimacion = await prisma.estimacion.create({
    data: {
      companyId: proyecto.companyId,
      proyectoId: proyecto.id,
      presupuestoId: presupuesto.id,
      numero,
      periodoInicio: new Date(data.periodoInicio),
      periodoFin: new Date(data.periodoFin),
      estado: "BORRADOR",
      subtotal: 0,
      iva: 0,
      total: 0,
    },
  });

  return NextResponse.json(estimacion, { status: 201 });
});
