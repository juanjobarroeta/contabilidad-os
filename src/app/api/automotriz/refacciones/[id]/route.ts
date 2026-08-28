import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { costoEnUnidadDeVenta } from "@/lib/automotriz/unidad-refaccion";

/**
 * GET /api/automotriz/refacciones/[id] — la FICHA de la parte: kardex con su
 * CFDI de origen, existencia/comprometida/disponible, demanda mensual (12m),
 * margen con costo comparable, en qué órdenes abiertas está, y las
 * APLICACIONES (a qué modelos le queda) parseadas de la propia descripción
 * del CFDI — «…MODELO: J4, J7, T6» ya venía en el comprobante.
 */

const r2 = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

/** «FILTRO DE ACEITE MODELO: SEI7, T6, T8» → ["SEI7", "T6", "T8"] */
function parsearAplicaciones(descripcion: string | null): string[] {
  if (!descripcion) return [];
  const m = descripcion.match(/MODELOS?\s*:?\s*(.+)$/i);
  if (!m) return [];
  return [...new Set(
    m[1]
      .split(/[,;/]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length >= 2 && s.length <= 20)
  )];
}

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const refaccion = await prisma.refaccion.findUnique({
    where: { id },
    include: {
      mercado: true,
      movimientos: {
        orderBy: { fecha: "desc" },
        take: 200,
        include: {
          invoice: { select: { id: true, uuid: true, serie: true, folio: true, fecha: true } },
        },
      },
    },
  });
  if (!refaccion) throw new AuthzError(404, "Refacción no encontrada");
  await requireMembership(refaccion.companyId, undefined, req);
  await requireModule(refaccion.companyId, "AUTOMOTRIZ", req);

  const [existencia, demandaMensual, enOrdenes] = await Promise.all([
    prisma.$queryRawUnsafe<{ existencia: number }[]>(
      `SELECT COALESCE(SUM(CASE WHEN tipo = 'ENTRADA_COMPRA' AND $2::float8 IS NOT NULL
                                THEN cantidad * $2::float8 ELSE cantidad END), 0)::float8 AS existencia
       FROM "RefaccionMovimiento" WHERE "refaccionId" = $1`,
      id,
      Number(refaccion.factorCosto) > 0 ? Number(refaccion.factorCosto) : null
    ),
    prisma.$queryRawUnsafe<{ mes: Date; salidas: number }[]>(
      `SELECT date_trunc('month', fecha) AS mes, COALESCE(SUM(-cantidad), 0)::float8 AS salidas
       FROM "RefaccionMovimiento"
       WHERE "refaccionId" = $1 AND tipo = 'SALIDA_VENTA' AND fecha >= NOW() - interval '12 months'
       GROUP BY 1 ORDER BY 1`,
      id
    ),
    prisma.$queryRawUnsafe<{ ordenId: string; folio: number; estado: string; cantidad: number }[]>(
      `SELECT o.id AS "ordenId", o.folio, o.estado::text AS estado, COALESCE(SUM(l.cantidad), 0)::float8 AS cantidad
       FROM "OrdenServicioLinea" l
       JOIN "OrdenServicio" o ON o.id = l."ordenId"
       WHERE l."refaccionId" = $1 AND l.tipo = 'REFACCION'
         AND o.estado IN ('RECIBIDA', 'EN_PROCESO', 'LISTA')
       GROUP BY o.id, o.folio, o.estado ORDER BY o.folio DESC`,
      id
    ),
  ]);

  const precio = refaccion.ultimoPrecio == null ? null : Number(refaccion.ultimoPrecio);
  // El costo EN UNIDAD DE VENTA (el helper del factor: tambo ÷ 208 = litro).
  const costoVenta = costoEnUnidadDeVenta({
    ultimoCosto: Number(refaccion.ultimoCosto),
    ultimoPrecio: precio,
    unidadCosto: refaccion.unidadCosto,
    unidadPrecio: refaccion.unidadPrecio,
    factorCosto: refaccion.factorCosto == null ? null : Number(refaccion.factorCosto),
  });
  const costoComparable = costoVenta != null;

  const exist = r2(Number(existencia[0]?.existencia ?? 0)) ?? 0;
  const comprometida = r2(enOrdenes.reduce((a, o) => a + o.cantidad, 0)) ?? 0;

  return NextResponse.json({
    ...refaccion,
    existencia: exist,
    comprometida,
    disponible: r2(exist - comprometida),
    costoComparable,
    margenPct:
      costoVenta != null && (precio ?? 0) > 0
        ? Math.round(((precio! - costoVenta) / precio!) * 1000) / 10
        : null,
    demandaMensual: demandaMensual.map((d) => ({ mes: d.mes, salidas: r2(d.salidas) ?? 0 })),
    enOrdenes: enOrdenes.map((o) => ({ ...o, cantidad: r2(o.cantidad) ?? 0 })),
    aplicaciones: parsearAplicaciones(refaccion.descripcion),
  });
});
