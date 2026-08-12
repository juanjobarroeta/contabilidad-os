// ─────────────────────────────────────────────────────────────────────────────
// Estado de resultados POR LÍNEA DE NEGOCIO — el cálculo, sin la ruta.
//
// Vive aquí y no dentro del endpoint porque lo consumen dos pantallas: el
// estado de resultados (periodo a elegir) y el panel (mes en curso). Si cada
// una lo calculara por su cuenta, tarde o temprano dirían números distintos de
// la misma utilidad, y el tablero dejaría de servir para decidir.
//
// Honestidades que el cálculo lleva encima en vez de esconder:
//   • Las cuotas patronales NO vienen en el CFDI de nómina — se estiman con el
//     SBC de cada recibo; la liquidación real la emite el IMSS por SUA.
//   • El costo de refacciones es ESTIMADO con el último costo conocido de cada
//     parte (el kardex no guarda capas de costo).
//   • Las unidades sin costo de compra conocido quedan fuera del margen.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from "@prisma/client";
import { gastosDeOperacion, type GastosResultado } from "./resultados-gastos";
import { otrosIngresos, type OtrosIngresosResultado } from "./otros-ingresos";

const r2 = (n: number) => Math.round(n * 100) / 100;
const margen = (utilidad: number, ingreso: number) => (ingreso > 0 ? r2((utilidad / ingreso) * 100) : null);

export interface LineaResultado {
  clave: string;
  nombre: string;
  ingreso: number;
  costo: number;
  utilidad: number;
  margen: number | null;
  unidades?: number;
  sinCosto?: number;
  ingresoSinCosto?: number;
  ordenes?: number;
  piezas?: number;
  costoEstimado: boolean;
  costoEsNomina?: boolean;
  /** Ingreso que no consume inventario ni horas: su utilidad ES el ingreso. */
  sinCostoDirecto?: boolean;
}

export type UnidadVendida = {
  id: string;
  vin: string;
  marca: string;
  modelo: string;
  anio: number;
  tipo: string;
  fechaVenta: Date | null;
  precioVenta: number | null;
  costoCompra: number;
  comisionMonto: number;
  isan: number;
  cliente: { id: string; razonSocial: string } | null;
  costos: Array<{ monto: number }>;
};

export interface ResultadosPeriodo {
  lineas: LineaResultado[];
  totales: {
    ingreso: number;
    utilidadBruta: number;
    margenBruto: number | null;
    utilidad: number;
    margen: number | null;
    ingresoSinCosto: number;
  };
  gastos: Array<{ clave: string; nombre: string; monto: number; cuenta?: string; facturas?: number }>;
  estructura: number;
  nomina: {
    percepciones: number;
    cuotasPatronales: number;
    total: number;
    recibos: number;
    porLinea: Array<{ linea: string; percepciones: number; cuotasPatronales: number; monto: number; recibos: number }>;
    porSucursal: Array<{ sucursal: string; monto: number }>;
  };
  /**
   * Absorción de servicio: qué tanto de la estructura de la agencia pagan por
   * sí solos el taller y refacciones. Es EL indicador del back end — una
   * agencia con absorción alta sobrevive un mes malo de piso; una con absorción
   * baja depende de vender coches para pagar la luz.
   */
  absorcion: { utilidadFixedOps: number; estructura: number; porcentaje: number | null };
  /** Insumos crudos, para que quien llama arme detalle sin volver a consultar. */
  fuentes: {
    unidades: UnidadVendida[];
    servicios: Array<{ fecha: Date; manoObra: number; refacciones: number }>;
  };
}

export async function calcularResultados(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<ResultadosPeriodo> {
  const [unidades, servicios, refaccionesRaw, nomina, nominaPorSucursal, gastos, otros] = await Promise.all([
    db.vehiculo.findMany({
      where: {
        companyId,
        estado: { in: ["VENDIDO", "ENTREGADO"] },
        fechaVenta: { gte: desde, lt: hasta },
        precioVenta: { not: null },
      },
      select: {
        id: true, vin: true, marca: true, modelo: true, anio: true,
        tipo: true, fechaVenta: true, precioVenta: true, costoCompra: true, comisionMonto: true, isan: true,
        cliente: { select: { id: true, razonSocial: true } },
        costos: { select: { monto: true } },
      },
    }),
    db.servicioVenta.findMany({
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      select: { fecha: true, manoObra: true, refacciones: true },
    }),
    // Kardex de salidas del periodo, partido por origen: dentro de una orden
    // de taller vs mostrador. El costo va con el último costo conocido.
    db.$queryRaw<Array<{ en_orden: boolean; ingreso: number; costo: number; piezas: number }>>(Prisma.sql`
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
    db.nominaCosto.groupBy({
      by: ["linea"],
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      _sum: { percepciones: true, cuotasPatronales: true },
      _count: { _all: true },
    }),
    db.nominaCosto.groupBy({
      by: ["sucursal"],
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      _sum: { percepciones: true, cuotasPatronales: true },
      orderBy: { _sum: { percepciones: "desc" } },
    }),
    gastosDeOperacion(db, companyId, desde, hasta),
    otrosIngresos(db, companyId, desde, hasta),
  ]);

  return armar({
    unidades: unidades as UnidadVendida[],
    servicios, refaccionesRaw, nomina, nominaPorSucursal, gastos, otros,
  });
}

type NominaGrupo = {
  linea: string;
  _sum: { percepciones: number | null; cuotasPatronales: number | null };
  _count: { _all: number };
};

export interface InsumosResultados {
  unidades: UnidadVendida[];
  servicios: Array<{ fecha: Date; manoObra: number; refacciones: number }>;
  refaccionesRaw: Array<{ en_orden: boolean; ingreso: number; costo: number; piezas: number }>;
  nomina: NominaGrupo[];
  nominaPorSucursal: Array<{ sucursal: string | null; _sum: { percepciones: number | null; cuotasPatronales: number | null } }>;
  gastos: GastosResultado;
  otros?: OtrosIngresosResultado;
}

/** Armado puro del estado de resultados — sin DB, para poder fijarlo con casos. */
export function armar(d: InsumosResultados): ResultadosPeriodo {
  // Costo patronal = percepciones + cuotas patronales estimadas (IMSS/RCV +
  // 5% INFONAVIT). El CFDI no declara las cuotas, pero sí el SBC, así que el
  // costo real se reconstruye en vez de subestimarse ~25-30%.
  const nominaDe = (linea: string) => {
    const n = d.nomina.find((x) => x.linea === linea);
    return r2((n?._sum.percepciones ?? 0) + (n?._sum.cuotasPatronales ?? 0));
  };

  const porTipo = (tipo: "NUEVO" | "SEMINUEVO") => {
    const del = d.unidades.filter((u) => u.tipo === tipo);
    // Sin costo conocido (compra fuera del archivo del SAT): fuera del margen.
    const conCosto = del.filter((u) => u.costoCompra > 0);
    const ingreso = r2(conCosto.reduce((s, u) => s + (u.precioVenta ?? 0), 0));
    const costo = r2(
      conCosto.reduce((s, u) => s + u.costoCompra + u.costos.reduce((c, x) => c + x.monto, 0) + u.comisionMonto, 0)
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

  const manoObra = r2(d.servicios.reduce((s, x) => s + x.manoObra, 0));
  const costoManoObra = nominaDe("TALLER");
  const vacio = { ingreso: 0, costo: 0, piezas: 0 };
  const refEnOrden = d.refaccionesRaw.find((r) => r.en_orden) ?? vacio;
  const refMostrador = d.refaccionesRaw.find((r) => !r.en_orden) ?? vacio;

  const lineaRefacciones = (
    fuente: { ingreso: number; costo: number; piezas: number },
    nombre: string,
    clave: string
  ): LineaResultado => ({
    clave,
    nombre,
    ingreso: r2(fuente.ingreso),
    costo: r2(fuente.costo),
    utilidad: r2(fuente.ingreso - fuente.costo),
    margen: margen(fuente.ingreso - fuente.costo, fuente.ingreso),
    piezas: r2(fuente.piezas),
    costoEstimado: true,
  });

  const lineas: LineaResultado[] = [
    {
      clave: "unidades_nuevas", nombre: "Unidades nuevas",
      ingreso: nuevas.ingreso, costo: nuevas.costo, utilidad: nuevas.utilidad, margen: nuevas.margen,
      unidades: nuevas.unidades, sinCosto: nuevas.sinCosto, ingresoSinCosto: nuevas.ingresoSinCosto,
      costoEstimado: false,
    },
    {
      clave: "unidades_seminuevas", nombre: "Seminuevos",
      ingreso: seminuevas.ingreso, costo: seminuevas.costo, utilidad: seminuevas.utilidad, margen: seminuevas.margen,
      unidades: seminuevas.unidades, sinCosto: seminuevas.sinCosto, ingresoSinCosto: seminuevas.ingresoSinCosto,
      costoEstimado: false,
    },
    {
      clave: "mano_obra", nombre: "Mano de obra (taller)",
      ingreso: manoObra,
      // Costo = nómina de quienes producen el servicio (técnicos, lavadores,
      // asesores de servicio), clasificada desde el Puesto del CFDI de nómina.
      costo: costoManoObra,
      utilidad: r2(manoObra - costoManoObra),
      margen: margen(manoObra - costoManoObra, manoObra),
      ordenes: d.servicios.length,
      costoEstimado: false,
      costoEsNomina: true,
    },
    lineaRefacciones(refEnOrden, "Refacciones en órdenes de taller", "refacciones_taller"),
    lineaRefacciones(refMostrador, "Refacciones de mostrador / mayoreo", "refacciones_mostrador"),
    // Ingresos sin costo directo: el bono del distribuidor y el uso de
    // instalaciones no consumen inventario ni horas facturables, así que su
    // utilidad ES el ingreso. Se listan aparte para que nadie los confunda con
    // margen de operación.
    ...(d.otros?.lineas ?? []).map((l) => ({
      clave: `otros_${l.clave}`,
      nombre: l.nombre,
      ingreso: l.importe,
      costo: 0,
      utilidad: l.importe,
      margen: l.importe > 0 ? 100 : null,
      costoEstimado: false,
      sinCostoDirecto: true,
    })),
  ];

  const ingresoTotal = r2(lineas.reduce((s, l) => s + l.ingreso, 0));
  const utilidadBruta = r2(lineas.reduce((s, l) => s + l.utilidad, 0));
  // Nómina que NO produce ingreso directo: ventas y refacciones cargan a su
  // línea; administración es gasto de estructura, debajo del margen bruto.
  const nominaVentas = nominaDe("VENTAS");
  const nominaRefacciones = nominaDe("REFACCIONES");
  const nominaAdmin = nominaDe("ADMIN");
  const estructura = r2(nominaVentas + nominaRefacciones + nominaAdmin + d.gastos.total);
  const utilidadTotal = r2(utilidadBruta - estructura);

  // Absorción: utilidad bruta del back end (taller + refacciones) contra la
  // estructura completa. 100% = el back end paga solo toda la operación y cada
  // coche vendido es utilidad; es el estándar con el que se mide una agencia.
  // SÓLO lo que produce el taller. Ni el bono del distribuidor ni el UDI de las
  // aseguradoras entran: los dos se ganan en el front end (vender unidades y
  // colocar pólizas). El UDI engaña por el nombre —«uso de instalaciones»
  // suena a taller— pero meterlo aquí diría que el taller se paga solo cuando
  // lo pagó la venta de seguros.
  const utilidadFixedOps = r2(
    lineas
      .filter((l) => l.clave === "mano_obra" || l.clave.startsWith("refacciones_"))
      .reduce((s, l) => s + l.utilidad, 0)
  );

  return {
    lineas,
    totales: {
      ingreso: ingresoTotal,
      utilidadBruta,
      margenBruto: margen(utilidadBruta, ingresoTotal),
      utilidad: utilidadTotal,
      margen: margen(utilidadTotal, ingresoTotal),
      ingresoSinCosto: r2(nuevas.ingresoSinCosto + seminuevas.ingresoSinCosto),
    },
    gastos: [
      { clave: "nomina_ventas", nombre: "Nómina de ventas", monto: nominaVentas },
      { clave: "nomina_refacciones", nombre: "Nómina de refacciones", monto: nominaRefacciones },
      { clave: "nomina_admin", nombre: "Nómina de administración", monto: nominaAdmin },
      ...d.gastos.lineas.map((l) => ({
        clave: `gasto_${l.cuenta}`, nombre: l.label, monto: l.monto, cuenta: l.cuenta, facturas: l.facturas,
      })),
      ...(d.gastos.sinClasificar.facturas > 0
        ? [{
            clave: "gasto_sin_xml",
            nombre: `Sin clasificar (${d.gastos.sinClasificar.facturas} CFDI sin XML)`,
            monto: d.gastos.sinClasificar.monto,
          }]
        : []),
    ],
    estructura,
    nomina: {
      percepciones: r2(d.nomina.reduce((s, n) => s + (n._sum.percepciones ?? 0), 0)),
      cuotasPatronales: r2(d.nomina.reduce((s, n) => s + (n._sum.cuotasPatronales ?? 0), 0)),
      total: r2(d.nomina.reduce((s, n) => s + (n._sum.percepciones ?? 0) + (n._sum.cuotasPatronales ?? 0), 0)),
      recibos: d.nomina.reduce((s, n) => s + n._count._all, 0),
      porLinea: d.nomina.map((n) => ({
        linea: n.linea,
        percepciones: r2(n._sum.percepciones ?? 0),
        cuotasPatronales: r2(n._sum.cuotasPatronales ?? 0),
        monto: r2((n._sum.percepciones ?? 0) + (n._sum.cuotasPatronales ?? 0)),
        recibos: n._count._all,
      })),
      porSucursal: d.nominaPorSucursal.map((s) => ({
        sucursal: s.sucursal ?? "(sin plaza)",
        monto: r2((s._sum.percepciones ?? 0) + (s._sum.cuotasPatronales ?? 0)),
      })),
    },
    absorcion: {
      utilidadFixedOps,
      estructura,
      porcentaje: estructura > 0 ? r2((utilidadFixedOps / estructura) * 100) : null,
    },
    fuentes: { unidades: d.unidades, servicios: d.servicios },
  };
}

export interface AbsorcionMes {
  /** "2026-07" */
  mes: string;
  utilidadFixedOps: number;
  estructura: number;
  porcentaje: number | null;
}

/**
 * Serie mensual de absorción. No corre el estado de resultados doce veces —
 * para la absorción sólo hacen falta cuatro sumas por mes, y el desglose de
 * gastos por cuenta (lo caro, porque abre el XML) no cambia el total.
 */
export async function absorcionPorMes(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<AbsorcionMes[]> {
  type Fila = { mes: Date; valor: number };
  const mesClave = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  const [manoObra, nominaFilas, refacciones, gastoFilas] = await Promise.all([
    db.$queryRaw<Fila[]>(Prisma.sql`
      SELECT date_trunc('month', sv."fecha") AS mes, COALESCE(SUM(sv."manoObra"), 0)::float8 AS valor
      FROM "ServicioVenta" sv
      WHERE sv."companyId" = ${companyId} AND sv."fecha" >= ${desde} AND sv."fecha" < ${hasta}
      GROUP BY 1
    `),
    db.$queryRaw<Array<{ mes: Date; linea: string; valor: number }>>(Prisma.sql`
      SELECT date_trunc('month', n."fecha") AS mes, n."linea"::text AS linea,
             COALESCE(SUM(n."percepciones" + n."cuotasPatronales"), 0)::float8 AS valor
      FROM "NominaCosto" n
      WHERE n."companyId" = ${companyId} AND n."fecha" >= ${desde} AND n."fecha" < ${hasta}
      GROUP BY 1, 2
    `),
    db.$queryRaw<Array<{ mes: Date; ingreso: number; costo: number }>>(Prisma.sql`
      SELECT date_trunc('month', m."fecha") AS mes,
             COALESCE(SUM(ABS(m."cantidad") * COALESCE(m."montoUnitario", 0)), 0)::float8 AS ingreso,
             COALESCE(SUM(ABS(m."cantidad") * COALESCE(r."ultimoCosto", 0)), 0)::float8   AS costo
      FROM "RefaccionMovimiento" m
      JOIN "Refaccion" r ON r.id = m."refaccionId"
      WHERE r."companyId" = ${companyId} AND m."tipo" = 'SALIDA_VENTA'
        AND m."fecha" >= ${desde} AND m."fecha" < ${hasta}
      GROUP BY 1
    `),
    // Gasto de operación por mes: mismas exclusiones que gastosDeOperacion
    // (compra de unidad, costo atribuido a un VIN, entrada al kardex) y la
    // nota de crédito recibida restando.
    db.$queryRaw<Fila[]>(Prisma.sql`
      SELECT date_trunc('month', i."fecha") AS mes,
             COALESCE(SUM(CASE WHEN i."tipoSat" = 'E' THEN -i."subtotal" ELSE i."subtotal" END), 0)::float8 AS valor
      FROM "Invoice" i
      WHERE i."companyId" = ${companyId}
        AND i."tipo" = 'EGRESO' AND i."status" <> 'CANCELLED'
        AND i."fecha" >= ${desde} AND i."fecha" < ${hasta}
        AND NOT EXISTS (SELECT 1 FROM "Vehiculo" v WHERE v."compraInvoiceId" = i.id)
        AND NOT EXISTS (SELECT 1 FROM "VehiculoCosto" vc WHERE vc."invoiceId" = i.id)
        AND NOT EXISTS (SELECT 1 FROM "RefaccionMovimiento" rm WHERE rm."invoiceId" = i.id)
      GROUP BY 1
    `),
  ]);

  const meses = new Map<string, AbsorcionMes>();
  const fila = (m: Date) => {
    const k = mesClave(new Date(m));
    let f = meses.get(k);
    if (!f) meses.set(k, (f = { mes: k, utilidadFixedOps: 0, estructura: 0, porcentaje: null }));
    return f;
  };

  for (const r of manoObra) fila(r.mes).utilidadFixedOps += r.valor;
  for (const r of refacciones) fila(r.mes).utilidadFixedOps += r.ingreso - r.costo;
  for (const r of nominaFilas) {
    // La nómina del taller es COSTO de la mano de obra; la demás es estructura.
    if (r.linea === "TALLER") fila(r.mes).utilidadFixedOps -= r.valor;
    else fila(r.mes).estructura += r.valor;
  }
  for (const r of gastoFilas) fila(r.mes).estructura += r.valor;

  return [...meses.values()]
    .map((f) => ({
      mes: f.mes,
      utilidadFixedOps: r2(f.utilidadFixedOps),
      estructura: r2(f.estructura),
      porcentaje: f.estructura > 0 ? r2((f.utilidadFixedOps / f.estructura) * 100) : null,
    }))
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

export const NOTAS_RESULTADOS = [
  "El costo de la mano de obra es la nómina de quienes producen el servicio (técnicos, lavadores, asesores), clasificada desde el Puesto del CFDI de nómina.",
  "Las cuotas patronales (IMSS/RCV + 5% INFONAVIT) NO vienen en el CFDI — sólo la cuota obrera. Se estiman con el SBC y los días de cada recibo; la liquidación real la emite el IMSS por SUA y puede diferir. El ISN estatal no está incluido.",
  "El costo de refacciones es estimado con el último costo conocido de cada parte.",
  "Las unidades sin costo de compra (anteriores al archivo de 5 años del SAT) quedan fuera del margen y se reportan aparte.",
  "La absorción compara la utilidad bruta de taller y refacciones contra TODA la estructura: 100% significa que el back end paga solo la operación. Los bonos del distribuidor y el UDI de las aseguradoras NO cuentan: se ganan vendiendo unidades y colocando pólizas, no operando el taller.",
  "Los bonos, el UDI y «otros ingresos» se clasifican por la DESCRIPCIÓN del CFDI, no por la clave del SAT: la clave 8014xx mezcla los tres. Lo que no empata con ninguna regla cae en «Otros ingresos» a la vista, en vez de repartirse a ojo.",
  "Vista de operación derivada de CFDIs — el estado de resultados fiscal sale del ledger en ContabilidadOS.",
];
