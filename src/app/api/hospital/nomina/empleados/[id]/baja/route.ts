/**
 * POST /api/hospital/nomina/empleados/[id]/baja { fechaBaja, motivo, diasSalarioPendiente?, preview? }
 *
 * Baja con la misma regla que /api/nomina/baja (lib/nomina/baja.ts): desactiva
 * al empleado, crea el movimiento de BAJA al IMSS y calcula el finiquito
 * (liquidación si el despido es INJUSTIFICADO). `preview: true` sólo calcula
 * el finiquito, sin tocar nada.
 *
 * Puerta del hospital: página nomina y FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { MOTIVOS_BAJA, darDeBaja } from "@/lib/nomina/baja";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  fechaBaja: fechaSchema,
  motivo: z.enum(MOTIVOS_BAJA),
  diasSalarioPendiente: z.number().min(0).max(366).optional(),
  preview: z.boolean().optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const empleado = await prisma.employee.findUnique({ where: { id }, select: { companyId: true } });
  if (!empleado) return error("Empleado no encontrado", 404);
  const companyId = empleado.companyId;
  const d = parsed.data;

  if (d.preview) {
    await requireMembership(companyId, undefined, req);
    await requireModule(companyId, "HOSPITAL", req);
    const r = await darDeBaja({ companyId, employeeId: id, ...d });
    return NextResponse.json(r.body, { status: r.status });
  }

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await darDeBaja({ companyId, employeeId: id, ...d });
  if (r.status === 200) {
    bitacora(user, req, {
      companyId,
      accion: "nomina.empleado.baja",
      entidad: "Employee",
      entidadId: id,
      detalle: { fechaBaja: d.fechaBaja, motivo: d.motivo },
    });
  }
  return NextResponse.json(r.body, { status: r.status });
});
