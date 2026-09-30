/**
 * POST /api/hospital/requisiciones/[id]/aprobar
 *
 * Autoriza la compra: la requisición pasa a APROBADA y nace su orden de
 * compra (la unidad que se recibe, factura y paga). Exige COMPRAS_AUTORIZAR y
 * nadie autoriza la suya.
 */

import { NextResponse } from "next/server";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { aprobarRequisicion, companyDeRequisicion } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  await requireClinicalPermission(companyId, user.id, "COMPRAS_AUTORIZAR");
  const r = await aprobarRequisicion(id, companyId, user.id);
  bitacora(user, req, { companyId, accion: "hospital.requisicion.autorizar", entidad: "SolicitudCompra", entidadId: id, detalle: { folio: r.folio, ordenId: r.ordenId } });
  return NextResponse.json({ ok: true, ...r });
});
