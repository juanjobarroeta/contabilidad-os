/**
 * POST /api/hospital/requisiciones/[id]/rechazar { motivo }
 *
 * Rechaza con motivo (queda a la vista de quien pidió, que puede corregirla y
 * reenviarla). Exige COMPRAS_AUTORIZAR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { companyDeRequisicion, rechazarRequisicion } from "@/lib/hospital/requisiciones";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ motivo: z.string().trim().min(5, "Escribe el motivo (mínimo 5 caracteres)").max(500) });

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const companyId = await companyDeRequisicion(id);
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  await requireClinicalPermission(companyId, user.id, "COMPRAS_AUTORIZAR");
  const r = await rechazarRequisicion(id, companyId, user.id, parsed.data.motivo);
  bitacora(user, req, { companyId, accion: "hospital.requisicion.rechazar", entidad: "SolicitudCompra", entidadId: id, detalle: { folio: r.folio, motivo: parsed.data.motivo } });
  return NextResponse.json({ ok: true, ...r });
});
