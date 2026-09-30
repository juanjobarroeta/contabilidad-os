/**
 * GET /api/hospital/flujo?companyId=[&semanas=8]
 *
 * Flujo de efectivo proyectado por semana (lib/hospital/flujo-efectivo.ts):
 * saldo de bancos + cobranza esperada − órdenes por pagar − facturas de
 * proveedor sin orden − nómina estimada. Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { flujoEfectivo } from "@/lib/hospital/flujo-efectivo";

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const semanas = Math.min(Math.max(Number(sp.get("semanas")) || 8, 1), 26);
  return NextResponse.json(await flujoEfectivo(prisma, companyId, semanas));
});
