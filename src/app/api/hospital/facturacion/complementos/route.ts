/**
 * GET  /api/hospital/facturacion/complementos?companyId=
 *      Facturas PPD con saldo por complementar o con REPs: total, amparado,
 *      saldo, REPs vigentes, cobros conciliados en banco, cobros de caja
 *      ligados (con cuáles ya están amparados) y el siguiente REP sugerido.
 * POST /api/hospital/facturacion/complementos
 *      { companyId, invoiceId, cobroId?, monto?, fechaPago?, formaPago?, preview? }
 *      Con `cobroId` el monto, la fecha y la forma de pago salen del cobro de
 *      caja. `preview: true` sólo calcula parcialidad y saldos; sin él timbra el
 *      REP (lib/complementos-rep-emit.ts: parcialidad por UUID, saldos, IVA).
 *
 * Cancelar un REP es /facturas/[id]/cancelar (el mismo que las facturas).
 * Puerta del hospital: página facturacion · caja · cuentas; timbrar exige
 * FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod, fechaSchema } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { emitirComplementoPago, prepararRep } from "@/lib/complementos-rep-emit";
import { ESTADOS_COBRO_VIGENTE, complementosHospital, formaPagoSat } from "@/lib/hospital/complementos";

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json(await complementosHospital(prisma, companyId));
});

const schema = z.object({
  companyId: z.string().min(1),
  invoiceId: z.string().min(1),
  cobroId: z.string().min(1).optional(),
  monto: z.number().positive().optional(),
  fechaPago: fechaSchema.optional(),
  formaPago: z.string().regex(/^\d{2}$/).optional(),
  preview: z.boolean().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  let monto = d.monto;
  let fechaPago = d.fechaPago;
  let formaPago = d.formaPago;
  if (d.cobroId) {
    const cobro = await prisma.hospCobro.findUnique({ where: { id: d.cobroId } });
    if (!cobro || cobro.companyId !== d.companyId || cobro.invoiceId !== d.invoiceId) return error("El cobro no es de esta factura", 404);
    if (!(ESTADOS_COBRO_VIGENTE as readonly string[]).includes(cobro.estado)) return error("El cobro está cancelado o contracargado: no ampara un pago", 409);
    monto = monto ?? Number(cobro.monto);
    fechaPago = fechaPago ?? cobro.fecha.toISOString();
    formaPago = formaPago ?? formaPagoSat(cobro.formaPago, cobro.tipoTarjeta);
  }
  const input = { companyId: d.companyId, invoiceId: d.invoiceId, monto, fechaPago, formaPago };

  if (d.preview) {
    await requireMembership(d.companyId, undefined, req);
    await requireModule(d.companyId, "HOSPITAL", req);
    const prev = await prepararRep(input);
    if (!prev.ok) return error(prev.error, prev.status);
    return NextResponse.json({ ok: true, preview: { ...prev.preview, formaPago: formaPago ?? "03" } });
  }

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await emitirComplementoPago(input);
  if (!r.ok) return error(r.error, r.status);
  bitacora(user, req, {
    companyId: d.companyId,
    accion: "complemento.emitir",
    entidad: "Invoice",
    entidadId: d.invoiceId,
    detalle: { uuid: r.uuid, monto: r.monto, parcialidad: r.numParcialidad, parentUuid: r.parentUuid, cobroId: d.cobroId ?? null },
  });
  return NextResponse.json({ ok: true, uuid: r.uuid, monto: r.monto, parentUuid: r.parentUuid, numParcialidad: r.numParcialidad }, { status: 201 });
});
