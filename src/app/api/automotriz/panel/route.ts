/**
 * GET /api/automotriz/panel?companyId=…
 *
 * KPIs del Panel de la agencia (handoff «Nórdico»): piso (unidades, valor,
 * aging, +90 días), mes en curso (vendidas, ingresos, margen real por VIN,
 * ISAN causado) y feed de urgentes (unidades +90 días y apartadas sin
 * facturar) con liga a la unidad. Sólo lectura, todo derivado de datos que el
 * módulo ya posee — la posición fiscal completa vive en el hub (link out).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { absorcionPorMes, calcularResultados } from "@/lib/automotriz/resultados";
import { computeTaxPosition } from "@/lib/impuestos";
import { retencionesDelPeriodo } from "@/lib/fiscal/retenciones";

const r2 = (n: number) => Math.round(n * 100) / 100;
const DIA_MS = 24 * 60 * 60 * 1000;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const hoy = new Date();
  const year = hoy.getFullYear();
  const month = hoy.getMonth() + 1;
  // El mismo rango que usa el estado de resultados, para que la utilidad del
  // mes del panel y la del reporte sean el MISMO número.
  const inicioMes = new Date(year, month - 1, 1);
  const finMes = new Date(year, month, 1);
  // Doce meses hacia atrás, cerrando en el mes en curso: la serie de absorción.
  const inicioSerie = new Date(year, month - 12, 1);

  const ABIERTOS_CRM = ["NUEVO", "CONTACTADO", "CITA", "DEMO", "NEGOCIACION"] as const;
  const [
    enPiso, ordenesAbiertas, promesasVencidas, prospectosAbiertos, seguimientosVencidos,
    resultados, serieAbsorcion, ordenesFacturadas, refaccionesMostrador, fiscal, retenciones,
  ] = await Promise.all([
    prisma.vehiculo.findMany({
      where: { companyId, estado: { in: ["DISPONIBLE", "APARTADO"] } },
      select: {
        id: true, vin: true, marca: true, modelo: true, anio: true, estado: true, uso: true, tipo: true,
        costoCompra: true, fechaCompra: true,
        costos: { select: { monto: true } },
      },
    }),
    // La operación de HOY: taller y CRM (fases 5b/2) en el mismo vistazo.
    prisma.ordenServicio.groupBy({
      by: ["estado"],
      where: { companyId, estado: { in: ["RECIBIDA", "EN_PROCESO", "LISTA"] } },
      _count: { _all: true },
    }),
    prisma.ordenServicio.findMany({
      where: {
        companyId,
        estado: { in: ["RECIBIDA", "EN_PROCESO"] },
        prometidaAt: { lt: new Date() },
      },
      select: { id: true, folio: true, descripcionUnidad: true, prometidaAt: true },
      orderBy: { prometidaAt: "asc" },
      take: 5,
    }),
    prisma.prospecto.count({ where: { companyId, estado: { in: [...ABIERTOS_CRM] } } }),
    prisma.prospecto.count({
      where: { companyId, estado: { in: [...ABIERTOS_CRM] }, proximaAccion: { lt: new Date() } },
    }),
    // El estado de resultados del mes en curso: MISMO cálculo que el reporte.
    calcularResultados(prisma, companyId, inicioMes, finMes),
    absorcionPorMes(prisma, companyId, inicioSerie, finMes),
    // Órdenes de servicio FACTURADAS del mes (no las abiertas en piso).
    prisma.servicioVenta.aggregate({
      where: { companyId, fecha: { gte: inicioMes, lt: finMes } },
      _sum: { manoObra: true, refacciones: true, total: true },
      _count: { _all: true },
    }),
    // Refacciones de mostrador/mayoreo: salidas del kardex que NO van dentro de
    // una orden de taller (ésas ya las cuenta la línea de servicio).
    prisma.$queryRaw<Array<{ facturas: number; importe: number; piezas: number }>>`
      SELECT COUNT(DISTINCT m."invoiceId")::int                                          AS facturas,
             COALESCE(SUM(ABS(m."cantidad") * COALESCE(m."montoUnitario", 0)), 0)::float8 AS importe,
             COALESCE(SUM(ABS(m."cantidad")), 0)::float8                                  AS piezas
      FROM "RefaccionMovimiento" m
      JOIN "Refaccion" r ON r.id = m."refaccionId"
      WHERE r."companyId" = ${companyId}
        AND m."tipo" = 'SALIDA_VENTA'
        AND m."fecha" >= ${inicioMes} AND m."fecha" < ${finMes}
        AND NOT EXISTS (SELECT 1 FROM "ServicioVenta" sv WHERE sv."invoiceId" = m."invoiceId")
    `,
    // Impuestos PROYECTADOS: el mes en curso va a la mitad, así que el motor
    // fiscal corre sobre lo facturado hasta hoy. Es una proyección con lo que
    // ya existe, no la declaración — ésa se arma con el mes cerrado.
    computeTaxPosition(companyId, year, month),
    retencionesDelPeriodo(companyId, year, month),
  ]);

  const dias = (v: { fechaCompra: Date | null }) =>
    v.fechaCompra ? Math.floor((hoy.getTime() - v.fechaCompra.getTime()) / DIA_MS) : null;

  const valorPiso = r2(
    enPiso.reduce((s, v) => s + v.costoCompra + v.costos.reduce((c, x) => c + x.monto, 0), 0)
  );
  // Las demos/cortesías no suenan en el aging: están en piso a propósito.
  const enVenta = enPiso.filter((v) => v.uso === "VENTA");
  const masDe90 = enVenta.filter((v) => (dias(v) ?? 0) > 90);

  // Ventas de unidades del mes: salen del MISMO cálculo que el estado de
  // resultados, para que el panel no cuente una utilidad y el reporte otra.
  const vendidasMes = resultados.fuentes.unidades;
  const ingresosMes = r2(vendidasMes.reduce((s, v) => s + (v.precioVenta ?? 0), 0));
  const margenMes = r2(
    vendidasMes.reduce(
      (s, v) =>
        s + (v.precioVenta ?? 0) - v.costoCompra -
        v.costos.reduce((c, x) => c + x.monto, 0) - v.comisionMonto,
      0
    )
  );
  const isanMes = r2(vendidasMes.reduce((s, v) => s + v.isan, 0));
  const porTipoMes = (tipo: string) => {
    const del = vendidasMes.filter((v) => v.tipo === tipo);
    return { unidades: del.length, monto: r2(del.reduce((s, v) => s + (v.precioVenta ?? 0), 0)) };
  };

  // Urgentes: primero las unidades con más días en piso, luego apartadas.
  const urgentes = [
    ...masDe90
      .sort((a, b) => (dias(b) ?? 0) - (dias(a) ?? 0))
      .slice(0, 5)
      .map((v) => ({
        tipo: "PISO_90" as const,
        vehiculoId: v.id,
        titulo: `${v.marca} ${v.modelo} ${v.anio}`,
        detalle: `${dias(v)} días en piso · VIN ${v.vin}`,
      })),
    ...enPiso
      .filter((v) => v.estado === "APARTADO")
      .slice(0, 5)
      .map((v) => ({
        tipo: "APARTADA" as const,
        vehiculoId: v.id,
        titulo: `${v.marca} ${v.modelo} ${v.anio}`,
        detalle: `Apartada sin facturar · VIN ${v.vin}`,
      })),
  ];

  const mostrador = refaccionesMostrador[0] ?? { facturas: 0, importe: 0, piezas: 0 };

  return NextResponse.json({
    periodo: { year, month },
    piso: {
      unidades: enPiso.length,
      valorPiso,
      masDe90: masDe90.length,
      diasPromedio: enVenta.length
        ? Math.round(enVenta.reduce((s, v) => s + (dias(v) ?? 0), 0) / enVenta.length)
        : 0,
      demos: enPiso.filter((v) => v.uso !== "VENTA").length,
      // Piso partido por tipo: un seminuevo parado no se lee igual que uno nuevo.
      nuevas: enPiso.filter((v) => v.tipo === "NUEVO").length,
      seminuevas: enPiso.filter((v) => v.tipo === "SEMINUEVO").length,
    },
    mes: {
      vendidas: vendidasMes.length,
      ingresos: ingresosMes,
      margen: margenMes,
      isan: isanMes,
      nuevas: porTipoMes("NUEVO"),
      seminuevas: porTipoMes("SEMINUEVO"),
      // Utilidad del negocio COMPLETO en el mes, no sólo de las unidades:
      // bruta = todas las líneas; neta = después de la estructura.
      utilidadBruta: resultados.totales.utilidadBruta,
      utilidadNeta: resultados.totales.utilidad,
      ingresoTotal: resultados.totales.ingreso,
      estructura: resultados.estructura,
    },
    // Back end del mes: lo que el taller y el mostrador realmente facturaron.
    servicio: {
      ordenesFacturadas: ordenesFacturadas._count._all,
      monto: r2(ordenesFacturadas._sum.total ?? 0),
      manoObra: r2(ordenesFacturadas._sum.manoObra ?? 0),
      refacciones: r2(ordenesFacturadas._sum.refacciones ?? 0),
    },
    refacciones: {
      facturas: mostrador.facturas,
      monto: r2(mostrador.importe),
      piezas: r2(mostrador.piezas),
    },
    // Absorción: qué tanto de la estructura pagan solos el taller y refacciones.
    absorcion: { ...resultados.absorcion, serie: serieAbsorcion },
    // Impuestos PROYECTADOS del mes en curso — con lo facturado hasta hoy, no
    // la declaración (ésa se arma con el mes cerrado, en Impuestos).
    impuestos: {
      proyectado: true,
      iva: r2(Math.max(fiscal.iva.pagar, 0)),
      ivaSaldoAFavor: r2(fiscal.iva.saldoAFavor),
      isr: r2(Math.max(fiscal.isr.isrPagar ?? 0, 0)),
      retenciones: retenciones.aEnterar,
      total: r2(Math.max(fiscal.iva.pagar, 0) + Math.max(fiscal.isr.isrPagar ?? 0, 0) + retenciones.aEnterar),
    },
    taller: {
      abiertas: ordenesAbiertas.reduce((s, o) => s + o._count._all, 0),
      porEstado: Object.fromEntries(ordenesAbiertas.map((o) => [o.estado, o._count._all])),
      promesasVencidas: promesasVencidas.map((o) => ({
        id: o.id,
        folio: o.folio,
        unidad: o.descripcionUnidad,
        prometidaAt: o.prometidaAt,
      })),
    },
    crm: { abiertos: prospectosAbiertos, vencidos: seguimientosVencidos },
    urgentes,
  });
});
