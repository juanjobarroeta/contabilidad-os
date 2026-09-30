/**
 * PATCH /api/hospital/nomina/empleados/[id] { campos a cambiar…, skipImssMovimiento? }
 *
 * Edición parcial con la misma regla que PATCH /api/empleados
 * (lib/nomina/empleados.ts): un cambio de salario recalcula el SDI y registra
 * la modificación al IMSS, salvo `skipImssMovimiento` (corrección de captura).
 * RFC, CURP y NSS no se editan aquí (identidad fiscal del recibo).
 *
 * Puerta del hospital: página nomina y FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { actualizarEmpleado } from "@/lib/nomina/empleados";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return error("Cuerpo inválido");
  const empleado = await prisma.employee.findUnique({ where: { id }, select: { companyId: true } });
  if (!empleado) return error("Empleado no encontrado", 404);
  const { user } = await requireWriter(empleado.companyId, req);
  await requireModule(empleado.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { companyId: _c, employeeId: _e, ...campos } = body as Record<string, unknown>;
  const r = await actualizarEmpleado(empleado.companyId, id, campos);
  if (r.status === 200) {
    bitacora(user, req, {
      companyId: empleado.companyId,
      accion: "nomina.empleado.editar",
      entidad: "Employee",
      entidadId: id,
      detalle: { campos: Object.keys(campos) },
    });
  }
  return NextResponse.json(r.body, { status: r.status });
});
