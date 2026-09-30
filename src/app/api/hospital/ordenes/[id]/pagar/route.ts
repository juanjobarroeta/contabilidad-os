/**
 * POST /api/hospital/ordenes/[id]/pagar { fecha?, monto?, referencia?, comprobante?: { data, mime?, name? } }
 *
 * Tesorería registra el pago (hecho en el portal del banco) de una orden con
 * el pago autorizado. Parciales permitidos (monto; default el saldo). Exige
 * TESORERIA_PAGAR y no lo registra quien autorizó el pago. No toca bancos ni
 * contabilidad: la salida real se concilia después en el hub contra la factura.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, fechaSchema } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { companyDeOrden, registrarPago } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  fecha: fechaSchema.optional(),
  monto: z.number().positive().max(1_000_000_000).optional(),
  referencia: z.string().trim().max(120).nullable().optional(),
  comprobante: z
    .object({ data: z.string().min(1).max(8_000_000), mime: z.string().max(120).optional(), name: z.string().max(200).optional() })
    .nullable()
    .optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const companyId = await companyDeOrden(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  await requireClinicalPermission(companyId, user.id, "TESORERIA_PAGAR");
  const d = parsed.data;
  const r = await registrarPago(id, companyId, user.id, { ...d, fecha: d.fecha ? new Date(d.fecha) : undefined });
  bitacora(user, req, { companyId, accion: "hospital.orden.pagar", entidad: "SolicitudAdjudicacion", entidadId: id, detalle: { pagoId: r.pagoId, monto: r.monto, referencia: d.referencia ?? null } });
  return NextResponse.json({ ok: true, ...r }, { status: 201 });
});
