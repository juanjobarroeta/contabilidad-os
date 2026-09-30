/**
 * POST /api/hospital/facturacion/facturas/[id]/sustituir { formaPago?, metodoPago?, usoCfdi?, notes?, customerId? }
 *
 * Primer paso de la cancelación con motivo 01: arma la prefactura que
 * SUSTITUYE a este CFDI —los mismos cargos de la cuenta, relación 04 al UUID
 * viejo— para corregir receptor o datos de pago. Al timbrarla los cargos pasan
 * al CFDI nuevo; después se cancela el viejo con motivo 01 y el UUID nuevo.
 * Si se descarta, los cargos siguen amparados por el CFDI viejo.
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
import { prefacturaSustituta } from "@/lib/hospital/facturacion";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  customerId: z.string().min(1).optional(),
  formaPago: z.string().min(1).optional(),
  metodoPago: z.enum(["PUE", "PPD"]).optional(),
  usoCfdi: z.string().min(1).optional(),
  notes: z.string().max(1000).optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return errorZod(parsed.error);
  const invoice = await prisma.invoice.findUnique({ where: { id }, select: { companyId: true } });
  if (!invoice) return error("Factura no encontrada", 404);
  const { user } = await requireWriter(invoice.companyId, req);
  await requireModule(invoice.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const { customerId, notes, ...datos } = parsed.data;
  const r = await prefacturaSustituta({ companyId: invoice.companyId, invoiceId: id, customerId, datos: { ...datos, notes: notes?.trim() || undefined }, actor: user, req });
  return NextResponse.json(r.body, { status: r.status });
});
