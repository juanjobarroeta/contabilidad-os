/**
 * PUT    /api/construccion/trabajadores/[id] — editar datos y tarifa (o
 *        reactivar con isActive: true)
 * DELETE /api/construccion/trabajadores/[id] — dar de baja (soft: isActive
 *        false). No se borra: su asistencia y sus rayas pasadas lo citan.
 *
 * Cambiar la tarifa afecta las rayas que se GENEREN después; las ya
 * generadas guardan su importe.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { trabajadorUpdateSchema } from "@/lib/construccion/trabajador-schema";

async function load(id: string, req: Request) {
  const t = await prisma.trabajador.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!t) throw new AuthzError(404, "Trabajador no encontrado");
  await requireWriter(t.companyId, req);
  await requireModule(t.companyId, "CONSTRUCCION");
  return t;
}

export const PUT = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const t = await load(id, req);
    const parsed = trabajadorUpdateSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { employeeId, ...data } = parsed.data;
    if (employeeId) {
      const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { companyId: true } });
      if (!e || e.companyId !== t.companyId) {
        return NextResponse.json({ error: "Empleado inválido" }, { status: 400 });
      }
    }
    const updated = await prisma.trabajador.update({
      where: { id },
      data: {
        ...(data.nombre !== undefined ? { nombre: data.nombre } : {}),
        ...(data.telefono !== undefined ? { telefono: data.telefono } : {}),
        ...(data.especialidad !== undefined ? { especialidad: data.especialidad } : {}),
        ...(data.tipoPago !== undefined ? { tipoPago: data.tipoPago } : {}),
        ...(data.tarifa !== undefined ? { tarifa: data.tarifa } : {}),
        ...(data.horasJornada !== undefined ? { horasJornada: data.horasJornada } : {}),
        ...(employeeId !== undefined ? { employeeId } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
    return NextResponse.json(updated);
  }
);

export const DELETE = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    await load(id, req);
    await prisma.trabajador.update({ where: { id }, data: { isActive: false } });
    return NextResponse.json({ ok: true });
  }
);
