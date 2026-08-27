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
import { isanDelPeriodo } from "@/lib/automotriz/isan-periodo";

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
  // Mes anterior, para el comparativo del handoff. La cifra sola no dice si
  // está bien: $85,240 de interés de piso es bueno o malo según qué fue el mes
  // pasado, y eso es lo que decide si alguien hace algo hoy.
  const inicioPrevio = new Date(year, month - 2, 1);

  const [
    enPiso, ordenesAbiertas, promesasVencidas, prospectosAbiertos, seguimientosVencidos,
    resultados, serieAbsorcion, ordenesFacturadas, refaccionesMostrador, fiscal, retenciones,
    isan, timbrado, interesMes, interesPrevio, vendidasPrevio, resultadosPrevio, sinCfdiCompra,
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

    // ISAN causado del mes. Se calcula al vuelo y no se lee `Vehiculo.isan`:
    // las ventas que reconstruyó el derivador desde los CFDI nunca pasaron por
    // `vender()` y tienen ese campo en cero. Misma fuente que Impuestos, para
    // que el panel y la declaración no digan cosas distintas.
    isanDelPeriodo(prisma, companyId, year, month),

    // Estado de timbrado del mes. El SAT sólo nos deja tres estados reales:
    // timbrada, borrador y cancelada. «Cancelación en proceso» y «rechazada»
    // que dibuja el handoff NO tienen dónde vivir — no se guarda cuándo se
    // pidió la cancelación ni si el receptor la rechazó.
    prisma.invoice.groupBy({
      by: ["status"],
      where: { companyId, tipo: "INGRESO", fecha: { gte: inicioMes, lt: finMes } },
      _count: { _all: true },
      _sum: { total: true },
    }),

    // Interés de plan piso devengado en el mes y en el anterior.
    prisma.vehiculoCosto.aggregate({
      where: { vehiculo: { companyId }, tipo: "INTERES_PISO", fecha: { gte: inicioMes, lt: finMes } },
      _sum: { monto: true },
    }),
    prisma.vehiculoCosto.aggregate({
      where: { vehiculo: { companyId }, tipo: "INTERES_PISO", fecha: { gte: inicioPrevio, lt: inicioMes } },
      _sum: { monto: true },
    }),
    prisma.vehiculo.count({
      where: { companyId, fechaVenta: { gte: inicioPrevio, lt: inicioMes } },
    }),
    calcularResultados(prisma, companyId, inicioPrevio, inicioMes),

    // Unidades en piso cuyo costo no tiene CFDI que lo respalde: no entran a la
    // utilidad y son la alerta más cara del tablero.
    prisma.vehiculo.count({
      where: {
        companyId,
        estado: { in: ["DISPONIBLE", "APARTADO"] },
        compraInvoiceId: null,
        costoCompra: { gt: 0 },
      },
    }),
  ]);

  const dias = (v: { fechaCompra: Date | null }) =>
    v.fechaCompra ? Math.floor((hoy.getTime() - v.fechaCompra.getTime()) / DIA_MS) : null;

  const valorPiso = r2(
    enPiso.reduce((s, v) => s + Number(v.costoCompra) + v.costos.reduce((c, x) => c + Number(x.monto), 0), 0)
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
      monto: r2(Number(ordenesFacturadas._sum.total ?? 0)),
      manoObra: r2(Number(ordenesFacturadas._sum.manoObra ?? 0)),
      refacciones: r2(Number(ordenesFacturadas._sum.refacciones ?? 0)),
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
      // El impuesto propio de una distribuidora, en la misma suma que el IVA y
      // el ISR porque se entera el mismo día 17 (Art. 4 LFISAN).
      isan: r2(Math.max(isan.total, 0)),
      isanUnidades: isan.unidades.length,
      isanAvisos: isan.advertencias,
      retenciones: retenciones.aEnterar,
      total: r2(
        Math.max(fiscal.iva.pagar, 0) +
        Math.max(fiscal.isr.isrPagar ?? 0, 0) +
        Math.max(isan.total, 0) +
        retenciones.aEnterar
      ),
    },

    // Estado de timbrado del mes. Sólo los tres estados que el modelo conoce;
    // el handoff dibuja cinco y los dos que faltan se dicen en la pantalla en
    // vez de inventarles un conteo.
    timbrado: {
      emitidos: timbrado.reduce((a, t) => a + t._count._all, 0),
      buckets: Object.fromEntries(
        timbrado.map((t) => [t.status, { n: t._count._all, monto: r2(Number(t._sum.total ?? 0)) }])
      ),
      sinModelo: ["cancelacion_en_proceso", "rechazada"],
    },

    // El comparativo del handoff: la cifra sola no dice si está bien.
    comparativo: {
      vendidasPrevio,
      utilidadPrevio: r2(resultadosPrevio.totales.utilidad),
      interesMes: r2(Number(interesMes._sum.monto ?? 0)),
      interesPrevio: r2(Number(interesPrevio._sum.monto ?? 0)),
    },

    // Señales operativas para el feed de alertas, con su costo al lado.
    señales: { sinCfdiCompra },
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
