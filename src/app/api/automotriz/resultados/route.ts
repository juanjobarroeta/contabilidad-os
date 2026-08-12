import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/resultados?companyId=…&year=2026
//
// Estado de resultados POR LÍNEA DE NEGOCIO — como lee su negocio un
// distribuidor, no como lo declara: unidades nuevas, seminuevos, mano de obra,
// refacciones dentro de órdenes de taller y refacciones de mostrador/mayoreo.
//
// Todo sale de los CFDIs ya derivados; no hay captura. Dos honestidades que el
// reporte lleva encima en vez de esconder:
//   • La mano de obra NO tiene costo asignado: el costo del taller es la
//     nómina de técnicos, que este módulo no reparte. Se reporta ingreso, no
//     utilidad.
//   • El costo de refacciones es ESTIMADO con el último costo conocido de cada
//     parte (el kardex no guarda capas de costo). Sirve para dimensionar el
//     margen, no para el cierre fiscal.
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
  const desde = new Date(year, 0, 1);
  const hasta = new Date(year + 1, 0, 1);

  const [unidades, servicios, refaccionesRaw, nomina, nominaPorSucursal] = await Promise.all([
    prisma.vehiculo.findMany({
      where: {
        companyId,
        estado: { in: ["VENDIDO", "ENTREGADO"] },
        fechaVenta: { gte: desde, lt: hasta },
        precioVenta: { not: null },
      },
      select: {
        tipo: true, fechaVenta: true, precioVenta: true, costoCompra: true, comisionMonto: true,
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
  const utilidadTotal = r2(utilidadBruta - nominaVentas - nominaRefacciones - nominaAdmin);

  return NextResponse.json({
    year,
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
    ],
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
    notas: [
      "El costo de la mano de obra es la nómina de quienes producen el servicio (técnicos, lavadores, asesores), clasificada desde el Puesto del CFDI de nómina.",
      "Las cuotas patronales (IMSS/RCV + 5% INFONAVIT) NO vienen en el CFDI — sólo la cuota obrera. Se estiman con el SBC y los días de cada recibo; la liquidación real la emite el IMSS por SUA y puede diferir. El ISN estatal no está incluido.",
      "El costo de refacciones es estimado con el último costo conocido de cada parte.",
      "Las unidades sin costo de compra (anteriores al archivo de 5 años del SAT) quedan fuera del margen y se reportan aparte.",
      "Vista de operación derivada de CFDIs — el estado de resultados fiscal sale del ledger en ContabilidadOS.",
    ],
  });
});
