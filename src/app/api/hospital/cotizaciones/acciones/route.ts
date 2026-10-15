/**
 * GET /api/hospital/cotizaciones/acciones?companyId=…
 * Qué puede hacer el usuario al cotizar: { puedeMoverPrecios } — precio
 * distinto del tarifario, partidas libres con precio y descuentos
 * (COTIZACION_PRECIOS). El hub lo vuelve a validar al guardar.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { PERMISO_PRECIOS } from "@/lib/hospital/cotizacion";
import { tieneClinicalPermission } from "@/lib/hospital/permisos";

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json({ puedeMoverPrecios: await tieneClinicalPermission(companyId, user.id, PERMISO_PRECIOS) });
});
