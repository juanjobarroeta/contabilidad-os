/**
 * GET /api/hospital/cotizaciones/[id]/versiones/[numero]
 *
 * Una versión guardada de la cotización: sus partidas a tarifa/lista, quién y
 * por qué, y qué cambió contra la versión anterior y contra el protocolo de
 * origen. Interno: no sale en el PDF del paciente.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { compararCotizacion, lineasDeJson } from "@/lib/hospital/cotizacion-historial";

type Ctx = { params: Promise<{ id: string; numero: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id, numero } = await ctx.params;
  const n = Number(numero);
  const c = await prisma.hospCotizacion.findUnique({ where: { id }, select: { companyId: true, folio: true, origenPaquete: true } });
  if (!c) throw new AuthzError(404, "Cotización no encontrada");
  await requireMembership(c.companyId, undefined, req);
  await requireModule(c.companyId, "HOSPITAL", req);
  if (!Number.isInteger(n) || n < 1) throw new AuthzError(404, "Versión no encontrada");

  const [v, anterior] = await Promise.all([
    prisma.hospCotizacionVersion.findUnique({ where: { cotizacionId_numero: { cotizacionId: id, numero: n } } }),
    n > 1 ? prisma.hospCotizacionVersion.findUnique({ where: { cotizacionId_numero: { cotizacionId: id, numero: n - 1 } } }) : null,
  ]);
  if (!v) throw new AuthzError(404, "Versión no encontrada");
  const foto = (x: { partidas: unknown; total: unknown }) => ({ lineas: lineasDeJson(x.partidas), total: Number(x.total) });
  return NextResponse.json({
    folio: c.folio,
    numero: v.numero,
    createdAt: v.createdAt,
    userNombre: v.userNombre,
    motivo: v.motivo,
    reconstruida: v.reconstruida,
    precioPaquete: v.precioPaquete == null ? null : Number(v.precioPaquete),
    subtotal: Number(v.subtotal),
    iva: Number(v.iva),
    total: Number(v.total),
    totalLista: Number(v.totalLista),
    lineas: lineasDeJson(v.partidas),
    contraAnterior: anterior ? compararCotizacion(foto(anterior), foto(v)) : null,
    contraOrigen: c.origenPaquete ? compararCotizacion(foto(c.origenPaquete), foto(v)) : null,
  });
});
