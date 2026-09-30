/**
 * GET /api/hospital/tesoreria?companyId=
 *
 * La bandeja de tesorería: lo AUTORIZADO por pagar (por fecha programada o
 * vencimiento), lo que espera autorización de pago, y lo pagado que el banco
 * todavía no refleja (por conciliar). Sólo lectura; pagar es
 * /ordenes/[id]/pagar.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { ordenesDeCompra } from "@/lib/hospital/requisiciones";
import { nombresDeUsuarios } from "@/lib/hospital/requisiciones-http";

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withHospital(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  const { user } = await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const todas = await ordenesDeCompra(prisma, companyId, {});
  const cuando = (o: (typeof todas)[number]) => new Date(o.autorizacionPago?.fechaProgramada ?? o.vencimiento ?? o.aprobadaAt ?? 0).getTime();
  const porPagar = todas.filter((o) => o.etapa === "EN_TESORERIA").sort((a, b) => cuando(a) - cuando(b));
  const porAutorizar = todas.filter((o) => o.etapa === "POR_AUTORIZAR_PAGO" || ((o.etapa === "POR_FACTURAR" || o.etapa === "POR_RECIBIR") && o.pago.saldo > 0)).sort((a, b) => cuando(a) - cuando(b));
  const porConciliar = todas.filter((o) => o.pago.aplicado > 0 && !o.conciliado);
  const nombres = await nombresDeUsuarios([...porPagar, ...porAutorizar].flatMap((o) => [o.creadaPorId, o.autorizacionPago?.porId]));
  const conNombres = (o: (typeof todas)[number]) => ({
    ...o,
    creadaPor: o.creadaPorId ? nombres[o.creadaPorId] ?? null : null,
    pagoAutorizadoPor: o.autorizacionPago?.porId ? nombres[o.autorizacionPago.porId] ?? null : null,
  });
  const hoy = Date.now();
  return NextResponse.json({
    usuarioId: user.id,
    totales: {
      porPagar: r2(porPagar.reduce((s, o) => s + o.pago.saldo, 0)),
      vencidoPorPagar: r2(porPagar.filter((o) => cuando(o) < hoy).reduce((s, o) => s + o.pago.saldo, 0)),
      porAutorizar: r2(porAutorizar.reduce((s, o) => s + o.pago.saldo, 0)),
      porConciliar: r2(porConciliar.reduce((s, o) => s + o.pago.aplicado, 0)),
    },
    porPagar: porPagar.map(conNombres),
    porAutorizar: porAutorizar.map(conNombres),
    porConciliar: porConciliar.map(conNombres),
  });
});
