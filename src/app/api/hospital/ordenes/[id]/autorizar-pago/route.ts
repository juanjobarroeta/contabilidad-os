/**
 * POST   /api/hospital/ordenes/[id]/autorizar-pago { fechaProgramada? }
 *        Manda la orden a tesorería: queda autorizada para pagarse (en la
 *        fecha programada, o a su vencimiento). Exige PAGOS_AUTORIZAR y no la
 *        autoriza quien pidió la compra.
 * DELETE /api/hospital/ordenes/[id]/autorizar-pago
 *        Retira la autorización mientras no haya pagos registrados.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, fechaSchema } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { autorizarPago, companyDeOrden, revocarAutorizacionPago } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };

async function puerta(id: string, req: Request) {
  const companyId = await companyDeOrden(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  await requireClinicalPermission(companyId, user.id, "PAGOS_AUTORIZAR");
  return { companyId, user };
}

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = z.object({ fechaProgramada: fechaSchema.nullable().optional() }).safeParse((await req.json().catch(() => null)) ?? {});
  if (!parsed.success) return error("fechaProgramada inválida");
  const { companyId, user } = await puerta(id, req);
  const fecha = parsed.data.fechaProgramada ? new Date(parsed.data.fechaProgramada) : null;
  const r = await autorizarPago(id, companyId, user.id, fecha);
  bitacora(user, req, { companyId, accion: "hospital.orden.autorizar-pago", entidad: "SolicitudAdjudicacion", entidadId: id, detalle: { folio: r.folio, fechaProgramada: fecha?.toISOString() ?? null } });
  return NextResponse.json({ ok: true, ...r });
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { companyId, user } = await puerta(id, req);
  const r = await revocarAutorizacionPago(id, companyId);
  bitacora(user, req, { companyId, accion: "hospital.orden.revocar-pago", entidad: "SolicitudAdjudicacion", entidadId: id, detalle: { folio: r.folio } });
  return NextResponse.json({ ok: true, ...r });
});
