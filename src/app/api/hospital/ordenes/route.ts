/**
 * GET /api/hospital/ordenes?companyId=[&abiertas=1][&autorizadas=1][&etapa=…]
 *
 * Órdenes de compra del hospital (una por requisición autorizada): recepción,
 * facturas ligadas y si el banco ya las pagó, vencimiento (factura o
 * autorización + días de crédito), pago y autorización de pago. Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { ordenesDeCompra } from "@/lib/hospital/requisiciones";
import { nombresDeUsuarios } from "@/lib/hospital/requisiciones-http";

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return error("companyId requerido");
  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  let ordenes = await ordenesDeCompra(prisma, companyId, { soloAbiertas: sp.get("abiertas") === "1", soloAutorizadas: sp.get("autorizadas") === "1" });
  const etapa = sp.get("etapa");
  if (etapa) ordenes = ordenes.filter((o) => o.etapa === etapa);
  const nombres = await nombresDeUsuarios(ordenes.flatMap((o) => [o.creadaPorId, o.aprobadaPorId, o.autorizacionPago?.porId]));
  return NextResponse.json({
    usuarioId: user.id,
    ordenes: ordenes.map((o) => ({
      ...o,
      creadaPor: o.creadaPorId ? nombres[o.creadaPorId] ?? null : null,
      aprobadaPor: o.aprobadaPorId ? nombres[o.aprobadaPorId] ?? null : null,
      pagoAutorizadoPor: o.autorizacionPago?.porId ? nombres[o.autorizacionPago.porId] ?? null : null,
    })),
  });
});
