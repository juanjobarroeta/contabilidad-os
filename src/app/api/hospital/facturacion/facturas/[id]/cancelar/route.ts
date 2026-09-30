/**
 * POST /api/hospital/facturacion/facturas/[id]/cancelar { motivo: "01"|"02"|"03"|"04", sustituyeUuid? }
 *
 * Cancela el CFDI ante el SAT con la misma regla que DELETE /api/facturas/[id]
 * (lib/facturas/cancelar.ts): motivo 01 exige el UUID que la sustituye, no se
 * cancela una factura con complementos de pago vivos, y sólo se marca
 * CANCELLED cuando el SAT lo confirma (si el receptor debe aceptar, queda «En
 * proceso» y vigente). Los cargos de la cuenta que amparaba vuelven a estar
 * libres en cuanto el CFDI queda cancelado (lib/hospital/facturacion.ts).
 *
 * Puerta del hospital: página facturacion · caja · cuentas y FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { MOTIVOS_CANCELACION, cancelarCfdi } from "@/lib/facturas/cancelar";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  motivo: z.enum(MOTIVOS_CANCELACION),
  sustituyeUuid: z.string().regex(/^[0-9a-fA-F-]{36}$/, "UUID inválido").optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const invoice = await prisma.invoice.findUnique({ where: { id }, select: { companyId: true } });
  if (!invoice) return error("Factura no encontrada", 404);
  const { user } = await requireWriter(invoice.companyId, req);
  await requireModule(invoice.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await cancelarCfdi({ invoiceId: id, motivo: parsed.data.motivo, sustituyeUuid: parsed.data.sustituyeUuid, actor: user, req });
  return NextResponse.json(r.body, { status: r.status });
});
