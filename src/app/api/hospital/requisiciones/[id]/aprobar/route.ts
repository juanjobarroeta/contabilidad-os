/**
 * POST /api/hospital/requisiciones/[id]/aprobar { ganadoras?: { [partidaId]: cotizacionId } }
 *
 * Autoriza la compra: la requisición pasa a APROBADA y nace una orden de
 * compra por proveedor ganador (la unidad que se pide, recibe, factura y
 * paga). Con `ganadoras`, quien autoriza cambia antes el proveedor de esas
 * líneas. Exige COMPRAS_AUTORIZAR y nadie autoriza la suya.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { aprobarRequisicion, companyDeRequisicion } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ ganadoras: z.record(z.string().min(1), z.string().min(1)).nullable().optional() }).nullable();

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  await requireClinicalPermission(companyId, user.id, "COMPRAS_AUTORIZAR");
  const r = await aprobarRequisicion(id, companyId, user.id, parsed.data?.ganadoras ?? null);
  bitacora(user, req, { companyId, accion: "hospital.requisicion.autorizar", entidad: "SolicitudCompra", entidadId: id, detalle: { folio: r.folio, ordenes: r.ordenes.map((o) => o.id), ganadoras: parsed.data?.ganadoras ?? null } });
  return NextResponse.json({ ok: true, ...r });
});
