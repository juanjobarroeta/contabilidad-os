/**
 * PATCH /api/hospital/servicios/[id]
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { serializarServicio, servicioSchema } from "@/lib/hospital/servicio-schema";

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = servicioSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const servicio = await prisma.hospServicio.findUnique({ where: { id }, select: { id: true, companyId: true, clave: true, precioLista: true } });
  if (!servicio) throw new AuthzError(404, "Servicio no encontrado");

  const { user } = await requireWriter(servicio.companyId, req);
  await requireModule(servicio.companyId, "HOSPITAL", req);

  const clave = d.clave?.trim().toUpperCase();
  if (clave && clave !== servicio.clave) {
    const dup = await prisma.hospServicio.findUnique({ where: { companyId_clave: { companyId: servicio.companyId, clave } }, select: { id: true } });
    if (dup) return error(`Ya existe un servicio con clave ${clave}`, 409);
  }

  const actualizado = await prisma.hospServicio.update({
    where: { id },
    data: { ...d, ...(clave ? { clave } : {}), ...(d.nombre ? { nombre: d.nombre.trim() } : {}) },
    include: { tarifas: { include: { pagador: { select: { id: true, nombre: true, tipo: true } } } } },
  });
  bitacora(user, req, {
    companyId: servicio.companyId,
    accion: "hospital.servicio.editar",
    entidad: "HospServicio",
    entidadId: id,
    detalle: { clave: servicio.clave, cambios: Object.keys(d), precioAntes: Number(servicio.precioLista), precioDespues: Number(actualizado.precioLista) },
  });
  return NextResponse.json(serializarServicio(actualizado));
});
