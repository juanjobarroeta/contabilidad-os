/**
 * PATCH /api/hospital/pagadores/[id]
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod } from "@/lib/hospital/http";
import { customerResumen, pagadorResumen } from "@/lib/hospital/serializar";
import { pagadorSchema } from "@/lib/hospital/pagador-schema";

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = pagadorSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { vigenciaInicio, vigenciaFin, ...d } = parsed.data;

  const pagador = await prisma.hospPagador.findUnique({ where: { id }, select: { id: true, companyId: true, nombre: true } });
  if (!pagador) throw new AuthzError(404, "Convenio no encontrado");

  const { user } = await requireWriter(pagador.companyId, req);
  await requireModule(pagador.companyId, "HOSPITAL", req);

  if (d.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: d.customerId }, select: { companyId: true } });
    if (!c || c.companyId !== pagador.companyId) return error("customerId inválido");
  }

  const actualizado = await prisma.hospPagador.update({
    where: { id },
    data: {
      ...d,
      ...(d.nombre ? { nombre: d.nombre.trim() } : {}),
      ...(vigenciaInicio !== undefined ? { vigenciaInicio: aFecha(vigenciaInicio) } : {}),
      ...(vigenciaFin !== undefined ? { vigenciaFin: aFecha(vigenciaFin) } : {}),
    },
    include: { customer: { select: { id: true, razonSocial: true, rfc: true } } },
  });
  bitacora(user, req, { companyId: pagador.companyId, accion: "hospital.pagador.editar", entidad: "HospPagador", entidadId: id, detalle: { nombre: pagador.nombre, cambios: Object.keys(parsed.data) } });
  return NextResponse.json({ ...actualizado, ...pagadorResumen(actualizado), customer: customerResumen(actualizado.customer) });
});
