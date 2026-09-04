/**
 * PUT /api/hospital/servicios/[id]/tarifas  { tarifas: [{ pagadorId, precio | null }] }
 *
 * Fija el precio del servicio por pagador; `precio: null` borra la tarifa
 * (vuelve al precio de lista). Sólo toca los pagadores que vienen en la lista.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { serializarServicio, tarifasSchema } from "@/lib/hospital/servicio-schema";

export const PUT = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = tarifasSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { tarifas } = parsed.data;

  const servicio = await prisma.hospServicio.findUnique({ where: { id }, select: { id: true, companyId: true, clave: true } });
  if (!servicio) throw new AuthzError(404, "Servicio no encontrado");

  const { user } = await requireWriter(servicio.companyId, req);
  await requireModule(servicio.companyId, "HOSPITAL", req);

  const ids = [...new Set(tarifas.map((t) => t.pagadorId))];
  const validos = await prisma.hospPagador.count({ where: { companyId: servicio.companyId, id: { in: ids } } });
  if (validos !== ids.length) return error("Algún pagadorId no es de esta empresa");

  const actualizado = await prisma.$transaction(async (tx) => {
    for (const t of tarifas) {
      if (t.precio == null) {
        await tx.hospTarifa.deleteMany({ where: { servicioId: id, pagadorId: t.pagadorId } });
      } else {
        await tx.hospTarifa.upsert({
          where: { servicioId_pagadorId: { servicioId: id, pagadorId: t.pagadorId } },
          create: { servicioId: id, pagadorId: t.pagadorId, precio: t.precio },
          update: { precio: t.precio },
        });
      }
    }
    return tx.hospServicio.findUniqueOrThrow({
      where: { id },
      include: { tarifas: { include: { pagador: { select: { id: true, nombre: true, tipo: true } } } } },
    });
  });

  bitacora(user, req, { companyId: servicio.companyId, accion: "hospital.tarifa.fijar", entidad: "HospServicio", entidadId: id, detalle: { clave: servicio.clave, tarifas } });
  return NextResponse.json(serializarServicio(actualizado));
});
