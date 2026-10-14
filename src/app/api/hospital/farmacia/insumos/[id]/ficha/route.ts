/**
 * GET /api/hospital/farmacia/insumos/[id]/ficha
 *
 * La ficha de compras de un insumo, sin datos de pacientes (la abre compras,
 * no sólo farmacia): datos del insumo, existencia, lotes con caducidad,
 * costo y proveedor, y sus compras — cada entrada con proveedor, CFDI y la
 * requisición que la amparó (quién pidió y autorizó), lo que viene en camino,
 * el historial de precios (entradas y cotizaciones) y el resumen por
 * proveedor. El kardex con sus salidas a pacientes sigue en
 * /farmacia/kardex (CLINICA_LEER). Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { diasDesde, r2 } from "@/lib/hospital/cobranza";
import { banderasControl } from "@/lib/hospital/controlados";
import { comprasDeInsumo } from "@/lib/hospital/ficha-insumo";

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const base = await prisma.hospInsumo.findUnique({ where: { id }, select: { companyId: true } });
  if (!base) throw new AuthzError(404, "Insumo no encontrado");
  const companyId = base.companyId;
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = new Date();
  const [insumo, config, suma, lotes, compras] = await Promise.all([
    prisma.hospInsumo.findUniqueOrThrow({ where: { id } }),
    prisma.hospConfig.findUnique({ where: { companyId }, select: { diasAlertaCaducidad: true } }),
    prisma.hospMovimientoInsumo.aggregate({ where: { insumoId: id }, _sum: { cantidad: true } }),
    prisma.hospLote.findMany({
      where: { insumoId: id },
      select: { id: true, lote: true, caducidad: true, existencia: true, costoUnitario: true, recibidoAt: true, bloqueado: true, supplier: { select: { id: true, razonSocial: true } } },
      orderBy: [{ caducidad: { sort: "asc", nulls: "last" } }],
    }),
    comprasDeInsumo(prisma, companyId, id),
  ]);
  const diasAlerta = config?.diasAlertaCaducidad ?? 90;
  return NextResponse.json({
    insumo: {
      ...insumo,
      ...banderasControl(insumo.grupoControl),
      minimo: Number(insumo.minimo),
      precioVenta: insumo.precioVenta == null ? null : Number(insumo.precioVenta),
      ultimoCosto: insumo.ultimoCosto == null ? null : Number(insumo.ultimoCosto),
      ivaTasa: insumo.ivaTasa == null ? null : Number(insumo.ivaTasa),
    },
    existencia: r2(Number(suma._sum.cantidad ?? 0)),
    lotes: lotes.map((l) => {
      const dias = l.caducidad ? diasDesde(hoy, l.caducidad) : null;
      return {
        ...l,
        existencia: r2(Number(l.existencia)),
        costoUnitario: Number(l.costoUnitario),
        diasParaCaducar: dias,
        estado: l.bloqueado ? "BLOQUEADO" : dias == null ? "EN_NIVEL" : dias < 0 ? "CADUCADO" : dias <= diasAlerta ? "CADUCA" : "EN_NIVEL",
      };
    }),
    compras,
  });
});
