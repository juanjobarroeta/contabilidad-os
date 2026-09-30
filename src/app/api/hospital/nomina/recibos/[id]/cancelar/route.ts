/**
 * POST /api/hospital/nomina/recibos/[id]/cancelar { motivo: "01"|"02"|"03"|"04", sustituyeUuid? }
 *
 * `id` es el PayrollItem (el renglón del empleado en la corrida). Misma regla
 * que /api/nomina/recibos/cancelar (lib/nomina/cancelar-recibo.ts): cancela el
 * CFDI de nómina ante el SAT y deja al empleado listo para retimbrar (la
 * corrida vuelve a CALCULATED; «Timbrar» sólo emite los que no tienen CFDI).
 *
 * Puerta del hospital: página nomina y FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { MOTIVOS_CANCELACION_NOMINA, cancelarReciboNomina } from "@/lib/nomina/cancelar-recibo";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  motivo: z.enum(MOTIVOS_CANCELACION_NOMINA),
  sustituyeUuid: z.string().regex(/^[0-9a-fA-F-]{36}$/, "UUID inválido").optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const item = await prisma.payrollItem.findUnique({ where: { id }, select: { payrollRun: { select: { companyId: true } } } });
  if (!item) return error("Recibo no encontrado", 404);
  const companyId = item.payrollRun.companyId;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await cancelarReciboNomina({ companyId, payrollItemId: id, ...parsed.data, actor: user, req });
  return NextResponse.json(r.body, { status: r.status });
});
