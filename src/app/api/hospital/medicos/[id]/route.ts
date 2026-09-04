/**
 * PATCH /api/hospital/medicos/[id]
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { medicoSchema } from "@/lib/hospital/medico-schema";

export const PATCH = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = medicoSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const medico = await prisma.hospMedico.findUnique({ where: { id }, select: { id: true, companyId: true, nombre: true } });
  if (!medico) throw new AuthzError(404, "Médico no encontrado");

  const { user } = await requireWriter(medico.companyId, req);
  await requireModule(medico.companyId, "HOSPITAL", req);

  if (d.supplierId) {
    const s = await prisma.supplier.findUnique({ where: { id: d.supplierId }, select: { companyId: true } });
    if (!s || s.companyId !== medico.companyId) return error("supplierId inválido");
  }
  if (d.employeeId) {
    const e = await prisma.employee.findUnique({ where: { id: d.employeeId }, select: { companyId: true } });
    if (!e || e.companyId !== medico.companyId) return error("employeeId inválido");
  }

  const actualizado = await prisma.hospMedico.update({
    where: { id },
    data: { ...d, ...(d.nombre ? { nombre: d.nombre.trim() } : {}), ...(d.rfc !== undefined ? { rfc: d.rfc?.trim().toUpperCase() || null } : {}) },
    include: { supplier: { select: { id: true, razonSocial: true, rfc: true } }, employee: { select: { id: true, nombre: true, apellidoPaterno: true } } },
  });
  bitacora(user, req, { companyId: medico.companyId, accion: "hospital.medico.editar", entidad: "HospMedico", entidadId: id, detalle: { nombre: medico.nombre, cambios: Object.keys(d) } });
  return NextResponse.json(actualizado);
});
