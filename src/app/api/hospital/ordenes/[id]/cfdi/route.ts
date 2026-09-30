/**
 * GET    /api/hospital/ordenes/[id]/cfdi                 Facturas del proveedor sin ligar, por cercanía al total.
 * POST   /api/hospital/ordenes/[id]/cfdi { invoiceId }   Liga la factura a la orden (mismo proveedor; una factura, una orden).
 * DELETE /api/hospital/ordenes/[id]/cfdi?invoiceId=      La suelta.
 *
 * Es el cruce orden ↔ factura: con la factura ligada, el vencimiento corre
 * desde la fecha del CFDI y la diferencia contra la orden queda a la vista.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { candidatosCfdi, companyDeOrden, desvincularCfdi, vincularCfdi } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const companyId = await companyDeOrden(id);
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json({ candidatos: await candidatosCfdi(id, companyId) });
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = z.object({ invoiceId: z.string().min(1) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error("invoiceId requerido");
  const companyId = await companyDeOrden(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await vincularCfdi(id, companyId, parsed.data.invoiceId);
  bitacora(user, req, { companyId, accion: "hospital.orden.ligar-cfdi", entidad: "SolicitudAdjudicacion", entidadId: id, detalle: r });
  return NextResponse.json({ ok: true, ...r });
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const invoiceId = new URL(req.url).searchParams.get("invoiceId");
  if (!invoiceId) return error("invoiceId requerido");
  const companyId = await companyDeOrden(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await desvincularCfdi(id, companyId, invoiceId);
  bitacora(user, req, { companyId, accion: "hospital.orden.soltar-cfdi", entidad: "SolicitudAdjudicacion", entidadId: id, detalle: r });
  return NextResponse.json({ ok: true, ...r });
});
