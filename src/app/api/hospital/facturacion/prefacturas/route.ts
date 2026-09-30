/**
 * GET  /api/hospital/facturacion/prefacturas?companyId=  — prefacturas PENDIENTES
 * POST /api/hospital/facturacion/prefacturas             — crea una (body = prefacturaSchema)
 *
 * La misma prefactura del hub (lib/facturas/prefacturas.ts) detrás de la
 * puerta del hospital: `requireModule(HOSPITAL)` aplica la página
 * (facturacion · caja · cuentas) y, para escribir, FINANZAS_ESCRIBIR — la
 * ruta genérica /api/facturas/borradores sólo mira el rol de la empresa.
 * El draft no consume timbre; timbrar es /prefacturas/[id] { accion: "timbrar" }.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import type { StampInput } from "@/lib/facturas/stamp";
import { prefacturaSchema } from "@/lib/facturas/prefactura";
import { crearPrefactura, listarPrefacturas } from "@/lib/facturas/prefacturas";

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json({ prefacturas: await listarPrefacturas(companyId) });
});

export const POST = withHospital(async (req: Request) => {
  const parsed = prefacturaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const input = parsed.data as StampInput;
  const { user } = await requireWriter(input.companyId, req);
  await requireModule(input.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await crearPrefactura(input, user, req);
  return NextResponse.json(r.body, { status: r.status });
});
