/**
 * GET /api/hospital/liquidaciones/sugerencias?companyId=…&afiliacionId=…&neto=…[&fecha&dias]
 *   → { pendientes: [...], dias: [{ dia, cobroIds, bruto, netoEsperado, distancia }] }
 *
 * `netoEsperado` sale de CÓMO liquida la afiliación (`liquidaEnBruto`), no de
 * su tasa: con un adquirente que deposita en bruto el día correcto tiene
 * distancia CERO, y descontarle una comisión que nadie descontó lo escondería.
 *
 * Dado el depósito que llegó al banco, agrupa los cobros sin liquidar por día
 * de operación y los ordena por qué tan cerca queda su neto estimado del
 * depósito. Es lo que hoy se hace a mano en Excel.
 *
 * PROPONE, NO ASIGNA: la liquidación la confirma una persona con POST
 * /api/hospital/liquidaciones. Un lote mal armado marcaría como depositados
 * cobros que el adquirente todavía no paga.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { cobrosPendientes, sugerirDias } from "@/lib/hospital/liquidaciones";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const afiliacionId = searchParams.get("afiliacionId");
  if (!companyId) return error("companyId requerido");
  if (!afiliacionId) return error("afiliacionId requerido");

  const neto = Number(searchParams.get("neto"));
  if (!Number.isFinite(neto) || neto <= 0) return error("neto requerido: el depósito que llegó al banco");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const af = await prisma.hospAfiliacion.findUnique({ where: { id: afiliacionId }, select: { companyId: true, tasa: true, liquidaEnBruto: true } });
  if (!af || af.companyId !== companyId) return error("Afiliación no encontrada", 404);

  const fechaParam = searchParams.get("fecha");
  const fecha = fechaParam ? new Date(fechaParam) : new Date();
  if (Number.isNaN(fecha.getTime())) return error("fecha inválida");
  const dias = Number(searchParams.get("dias") || 10);

  const pendientes = await cobrosPendientes(prisma, companyId, afiliacionId, fecha, Number.isFinite(dias) ? dias : 10);
  return NextResponse.json({
    pendientes,
    dias: sugerirDias(pendientes, neto, { liquidaEnBruto: af.liquidaEnBruto, tasa: af.tasa == null ? null : Number(af.tasa) }),
  });
});
