import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { cruceCompras } from "@/lib/hospital/cruce-compras";

/**
 * GET /api/hospital/compras/cruce?companyId=…&anio=2026&mes=8
 *
 * Recepción física contra CFDI del proveedor (lib/hospital/cruce-compras):
 * lotes sin CFDI, CFDIs de insumos sin recepción y devoluciones al proveedor
 * que esperan su nota de crédito. Sólo lectura.
 */
export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const hoy = new Date();
  const anio = Number(sp.get("anio") ?? hoy.getUTCFullYear());
  const mes = Number(sp.get("mes") ?? hoy.getUTCMonth() + 1);
  if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12 || anio < 2000 || anio > 2100) {
    return NextResponse.json({ error: "Periodo inválido" }, { status: 400 });
  }
  const desde = new Date(Date.UTC(anio, mes - 1, 1));
  const hasta = new Date(Date.UTC(anio, mes, 1));
  return NextResponse.json(await cruceCompras(prisma, companyId, desde, hasta));
});
