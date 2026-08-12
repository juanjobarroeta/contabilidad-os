import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { gastosDeOperacion } from "./gastos";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/resultados?companyId=…&year=2026
//
// Estado de resultados POR LÍNEA DE NEGOCIO — como lee su negocio un
// distribuidor, no como lo declara: unidades nuevas, seminuevos, mano de obra,
// refacciones dentro de órdenes de taller y refacciones de mostrador/mayoreo;
// debajo del margen bruto, la estructura (nómina que no produce + el resto de
// los CFDIs de egreso clasificados con el catálogo COE del SAT).
//
// Periodo: ejercicio completo, un mes (month=1..12) o al día (ytd=1).
//
// Todo sale de los CFDIs ya derivados; no hay captura. Honestidades que el
// reporte lleva encima en vez de esconder:
//   • Las cuotas patronales NO vienen en el CFDI de nómina — se estiman con el
//     SBC de cada recibo; la liquidación real la emite el IMSS por SUA.
//   • El costo de refacciones es ESTIMADO con el último costo conocido de cada
//     parte (el kardex no guarda capas de costo).
//   • Las unidades sin costo de compra conocido quedan fuera del margen.
//
// El estado de resultados FISCAL (el que cuadra con la contabilidad) vive en el
// hub y sale del ledger — este es el tablero de operación.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;
const margen = (utilidad: number, ingreso: number) => (ingreso > 0 ? r2((utilidad / ingreso) * 100) : null);

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const year = Number(searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Ejercicio inválido" }, { status: 400 });
  }
  // Periodo: el ejercicio completo, un mes (month=1..12) o al día de hoy
  // (ytd=1) — las tres lecturas que pide un director de agencia.
  const monthParam = searchParams.get("month");
  const month = monthParam ? Number(monthParam) : null;
  if (month != null && (!Number.isInteger(month) || month < 1 || month > 12)) {
    return NextResponse.json({ error: "Mes inválido" }, { status: 400 });
  }
  const ytd = searchParams.get("ytd") === "1";
  const hoy = new Date();
  const desde = month ? new Date(year, month - 1, 1) : new Date(year, 0, 1);
  const hasta = month
    ? new Date(year, month, 1)
    : ytd && year === hoy.getFullYear()
      ? new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() + 1)
      : new Date(year + 1, 0, 1);
  const periodo = month ? `${year}-${String(month).padStart(2, "0")}` : ytd ? `${year} al día` : String(year);

  const [unidades, servicios, refaccionesRaw, nomina, nominaPorSucursal, nominaPorEmpleado, gastos] =
    await Promise.all([
    prisma.vehiculo.findMany({
      where: {
        companyId,
        estado: { in: ["VENDIDO", "ENTREGADO"] },
        fechaVenta: { gte: desde, lt: hasta },
        precioVenta: { not: null },
      },
      select: {
        id: true, vin: true, marca: true, modelo: true, anio: true,
        tipo: true, fechaVenta: true, precioVenta: true, costoCompra: true, comisionMonto: true,
        cliente: { select: { id: true, razonSocial: true } },
        costos: { select: { monto: true } },
      },
    }),
    prisma.servicioVenta.findMany({
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      select: { fecha: true, manoObra: true, refacciones: true },
    }),
    // Kardex de salidas del ejercicio, partido por origen: dentro de una orden
    // de taller vs mostrador. El costo va con el último costo conocido.
    prisma.$queryRaw<Array<{ en_orden: boolean; ingreso: number; costo: number; piezas: number }>>(Prisma.sql`
      SELECT EXISTS (SELECT 1 FROM "ServicioVenta" sv WHERE sv."invoiceId" = m."invoiceId") AS en_orden,
             COALESCE(SUM(ABS(m."cantidad") * COALESCE(m."montoUnitario", 0)), 0)::float8 AS ingreso,
             COALESCE(SUM(ABS(m."cantidad") * COALESCE(r."ultimoCosto", 0)), 0)::float8   AS costo,
             COALESCE(SUM(ABS(m."cantidad")), 0)::float8                                   AS piezas
      FROM "RefaccionMovimiento" m
      JOIN "Refaccion" r ON r.id = m."refaccionId"
      WHERE r."companyId" = ${companyId}
        AND m."tipo" = 'SALIDA_VENTA'
        AND m."fecha" >= ${desde} AND m."fecha" < ${hasta}
      GROUP BY 1
    `),
    // Costo de nómina del ejercicio, ya clasificado por línea de negocio.
    prisma.nominaCosto.groupBy({
      by: ["linea"],
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      _sum: { percepciones: true, cuotasPatronales: true },
      _count: { _all: true },
    }),
    // Y por sucursal: el Departamento del CFDI de nómina es la plaza.
    prisma.nominaCosto.groupBy({
      by: ["sucursal"],
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      _sum: { percepciones: true, cuotasPatronales: true },
      orderBy: { _sum: { percepciones: "desc" } },
    }),
    // Y por persona: el desglose que pide un director cuando el total de una
    // línea no le cuadra. Se agrupa por RFC (estable) y se muestra el nombre
    // del último recibo del periodo.
    prisma.$queryRaw<
      Array<{
        rfc: string | null; empleado: string | null; puesto: string | null; sucursal: string | null;
        linea: string; percepciones: number; cuotas: number; recibos: number;
      }>
    >(Prisma.sql`
      SELECT n."rfcEmpleado" AS rfc,
             (array_agg(n."empleado" ORDER BY n."fecha" DESC))[1]  AS empleado,
             (array_agg(n."puesto"   ORDER BY n."fecha" DESC))[1]  AS puesto,
             (array_agg(n."sucursal" ORDER BY n."fecha" DESC))[1]  AS sucursal,
             (array_agg(n."linea"::text ORDER BY n."fecha" DESC))[1] AS linea,
             COALESCE(SUM(n."percepciones"), 0)::float8      AS percepciones,
             COALESCE(SUM(n."cuotasPatronales"), 0)::float8  AS cuotas,
             COUNT(*)::int                                    AS recibos
      FROM "NominaCosto" n
      WHERE n."companyId" = ${companyId}
        AND n."fecha" >= ${desde} AND n."fecha" < ${hasta}
      GROUP BY n."rfcEmpleado"
      ORDER BY 6 DESC
    `),
    // El resto de los CFDIs de egreso: el gasto de operación, clasificado con
    // el mismo mapa COE que usa el cierre mensual.
    gastosDeOperacion(prisma, companyId, desde, hasta),
  ]);

  // Costo patronal = percepciones + cuotas patronales estimadas (IMSS/RCV +
  // 5% INFONAVIT). El CFDI no declara las cuotas, pero sí el SBC, así que el
  // costo real se reconstruye en vez de subestimarse ~25-30%.
  const nominaDe = (linea: string) => {
    const n = nomina.find((x) => x.linea === linea);
    return r2((n?._sum.percepciones ?? 0) + (n?._sum.cuotasPatronales ?? 0));
  };

  // ── Unidades: nuevas y seminuevas, con su utilidad real por VIN ───────────
  const porTipo = (tipo: "NUEVO" | "SEMINUEVO") => {
    const del = unidades.filter((u) => u.tipo === tipo);
    // Sin costo conocido (compra fuera del archivo del SAT): fuera del margen.
    const conCosto = del.filter((u) => u.costoCompra > 0);
    const ingreso = r2(conCosto.reduce((s, u) => s + (u.precioVenta ?? 0), 0));
    const costo = r2(
      conCosto.reduce(
        (s, u) => s + u.costoCompra + u.costos.reduce((c, x) => c + x.monto, 0) + u.comisionMonto,
        0
      )
    );
    return {
      unidades: del.length,
      sinCosto: del.length - conCosto.length,
      ingresoSinCosto: r2(del.filter((u) => u.costoCompra <= 0).reduce((s, u) => s + (u.precioVenta ?? 0), 0)),
      ingreso,
      costo,
      utilidad: r2(ingreso - costo),
      margen: margen(ingreso - costo, ingreso),
    };
  };

  const nuevas = porTipo("NUEVO");
  const seminuevas = porTipo("SEMINUEVO");

  const manoObra = r2(servicios.reduce((s, x) => s + x.manoObra, 0));
  const refaccionesEnOrden = refaccionesRaw.find((r) => r.en_orden) ?? { ingreso: 0, costo: 0, piezas: 0 };
  const refaccionesMostrador = refaccionesRaw.find((r) => !r.en_orden) ?? { ingreso: 0, costo: 0, piezas: 0 };

  const lineaRefacciones = (fuente: { ingreso: number; costo: number; piezas: number }, nombre: string, clave: string) => ({
    clave,
    nombre,
    ingreso: r2(fuente.ingreso),
    costo: r2(fuente.costo),
    utilidad: r2(fuente.ingreso - fuente.costo),
    margen: margen(fuente.ingreso - fuente.costo, fuente.ingreso),
    piezas: r2(fuente.piezas),
    costoEstimado: true,
  });

  const lineas = [
    {
      clave: "unidades_nuevas",
      nombre: "Unidades nuevas",
      ingreso: nuevas.ingreso,
      costo: nuevas.costo,
      utilidad: nuevas.utilidad,
      margen: nuevas.margen,
      unidades: nuevas.unidades,
      sinCosto: nuevas.sinCosto,
      ingresoSinCosto: nuevas.ingresoSinCosto,
      costoEstimado: false,
    },
    {
      clave: "unidades_seminuevas",
      nombre: "Seminuevos",
      ingreso: seminuevas.ingreso,
      costo: seminuevas.costo,
      utilidad: seminuevas.utilidad,
      margen: seminuevas.margen,
      unidades: seminuevas.unidades,
      sinCosto: seminuevas.sinCosto,
      ingresoSinCosto: seminuevas.ingresoSinCosto,
      costoEstimado: false,
    },
    {
      clave: "mano_obra",
      nombre: "Mano de obra (taller)",
      ingreso: manoObra,
      // Costo = nómina de quienes producen el servicio (técnicos, lavadores,
      // asesores de servicio), clasificada desde el Puesto del CFDI de nómina.
      costo: nominaDe("TALLER"),
      utilidad: r2(manoObra - nominaDe("TALLER")),
      margen: margen(manoObra - nominaDe("TALLER"), manoObra),
      ordenes: servicios.length,
      costoEstimado: false,
      costoEsNomina: true,
    },
    lineaRefacciones(refaccionesEnOrden, "Refacciones en órdenes de taller", "refacciones_taller"),
    lineaRefacciones(refaccionesMostrador, "Refacciones de mostrador / mayoreo", "refacciones_mostrador"),
  ];

  // Mes a mes de lo que sí es comparable (unidades y taller).
  const meses = Array.from({ length: 12 }, (_, i) => ({
    mes: i + 1,
    nuevas: 0,
    seminuevas: 0,
    manoObra: 0,
    refacciones: 0,
  }));
  for (const u of unidades) {
    if (!u.fechaVenta) continue;
    const m = meses[new Date(u.fechaVenta).getMonth()];
    if (u.tipo === "NUEVO") m.nuevas = r2(m.nuevas + (u.precioVenta ?? 0));
    else m.seminuevas = r2(m.seminuevas + (u.precioVenta ?? 0));
  }
  for (const s of servicios) {
    const m = meses[new Date(s.fecha).getMonth()];
    m.manoObra = r2(m.manoObra + s.manoObra);
    m.refacciones = r2(m.refacciones + s.refacciones);
  }

  const ingresoTotal = r2(lineas.reduce((s, l) => s + l.ingreso, 0));
  const utilidadBruta = r2(lineas.reduce((s, l) => s + (l.utilidad ?? 0), 0));
  // Nómina que NO produce ingreso directo: ventas y refacciones cargan a su
  // línea; administración es gasto de estructura, debajo del margen bruto.
  const nominaVentas = nominaDe("VENTAS");
  const nominaRefacciones = nominaDe("REFACCIONES");
  const nominaAdmin = nominaDe("ADMIN");
  const estructura = r2(nominaVentas + nominaRefacciones + nominaAdmin + gastos.total);
  const utilidadTotal = r2(utilidadBruta - estructura);

  return NextResponse.json({
    year,
    periodo,
    lineas,
    totales: {
      ingreso: ingresoTotal,
      utilidadBruta,
      margenBruto: margen(utilidadBruta, ingresoTotal),
      utilidad: utilidadTotal,
      margen: margen(utilidadTotal, ingresoTotal),
      // Ingreso de unidades cuyo costo no se conoce: fuera del margen, visible.
      ingresoSinCosto: r2(nuevas.ingresoSinCosto + seminuevas.ingresoSinCosto),
    },
    // Nómina bajo el margen bruto: la estructura que sostiene la operación.
    gastos: [
      { clave: "nomina_ventas", nombre: "Nómina de ventas", monto: nominaVentas },
      { clave: "nomina_refacciones", nombre: "Nómina de refacciones", monto: nominaRefacciones },
      { clave: "nomina_admin", nombre: "Nómina de administración", monto: nominaAdmin },
      ...gastos.lineas.map((l) => ({ clave: `gasto_${l.cuenta}`, nombre: l.label, monto: l.monto, cuenta: l.cuenta, facturas: l.facturas })),
      ...(gastos.sinClasificar.facturas > 0
        ? [{
            clave: "gasto_sin_xml",
            nombre: `Sin clasificar (${gastos.sinClasificar.facturas} CFDI sin XML)`,
            monto: gastos.sinClasificar.monto,
          }]
        : []),
    ],
    estructura,
    nomina: {
      percepciones: r2(nomina.reduce((s, n) => s + (n._sum.percepciones ?? 0), 0)),
      cuotasPatronales: r2(nomina.reduce((s, n) => s + (n._sum.cuotasPatronales ?? 0), 0)),
      total: r2(
        nomina.reduce((s, n) => s + (n._sum.percepciones ?? 0) + (n._sum.cuotasPatronales ?? 0), 0)
      ),
      recibos: nomina.reduce((s, n) => s + n._count._all, 0),
      porLinea: nomina.map((n) => ({
        linea: n.linea,
        percepciones: r2(n._sum.percepciones ?? 0),
        cuotasPatronales: r2(n._sum.cuotasPatronales ?? 0),
        monto: r2((n._sum.percepciones ?? 0) + (n._sum.cuotasPatronales ?? 0)),
        recibos: n._count._all,
      })),
      porSucursal: nominaPorSucursal.map((s) => ({
        sucursal: s.sucursal ?? "(sin plaza)",
        monto: r2((s._sum.percepciones ?? 0) + (s._sum.cuotasPatronales ?? 0)),
      })),
    },
    porMes: meses,
    // Detalle para desplegar sin pedir otra pantalla: cada venta del periodo
    // con su utilidad, y la nómina agrupada por persona (puesto + plaza).
    detalle: {
      ventas: unidades
        .map((u) => {
          const costos = u.costos.reduce((s, c) => s + c.monto, 0);
          const sinCosto = u.costoCompra <= 0;
          return {
            id: u.id,
            vin: u.vin,
            unidad: `${u.marca} ${u.modelo} ${u.anio}`,
            tipo: u.tipo,
            fecha: u.fechaVenta,
            cliente: u.cliente?.razonSocial ?? null,
            clienteId: u.cliente?.id ?? null,
            precioVenta: u.precioVenta ?? 0,
            costo: sinCosto ? null : r2(u.costoCompra + costos + u.comisionMonto),
            utilidad: sinCosto ? null : r2((u.precioVenta ?? 0) - u.costoCompra - costos - u.comisionMonto),
          };
        })
        .sort((a, b) => (b.fecha && a.fecha ? +new Date(b.fecha) - +new Date(a.fecha) : 0)),
      nomina: nominaPorEmpleado.map((e) => ({
        rfc: e.rfc,
        empleado: e.empleado ?? e.rfc ?? "(sin nombre en el recibo)",
        puesto: e.puesto,
        sucursal: e.sucursal,
        linea: e.linea,
        percepciones: r2(e.percepciones),
        cuotasPatronales: r2(e.cuotas),
        monto: r2(e.percepciones + e.cuotas),
        recibos: e.recibos,
      })),
    },
    notas: [
      "El costo de la mano de obra es la nómina de quienes producen el servicio (técnicos, lavadores, asesores), clasificada desde el Puesto del CFDI de nómina.",
      "Las cuotas patronales (IMSS/RCV + 5% INFONAVIT) NO vienen en el CFDI — sólo la cuota obrera. Se estiman con el SBC y los días de cada recibo; la liquidación real la emite el IMSS por SUA y puede diferir. El ISN estatal no está incluido.",
      "El costo de refacciones es estimado con el último costo conocido de cada parte.",
      "Las unidades sin costo de compra (anteriores al archivo de 5 años del SAT) quedan fuera del margen y se reportan aparte.",
      "Vista de operación derivada de CFDIs — el estado de resultados fiscal sale del ledger en ContabilidadOS.",
    ],
  });
});
