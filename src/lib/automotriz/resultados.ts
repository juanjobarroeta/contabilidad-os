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
  /**
   * Línea cuyo COSTO no viene de CFDIs sino de cuadrar contra los libros. Hoy
   * sólo la de unidades sin CFDI de compra: su ingreso es real (la venta sí se
   * facturó) y su costo sale por diferencia contra la Contabilidad Electrónica.
   */
  costoDesdeLibros?: boolean;
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
  ventaInvoice?: { contraparteNombre: string | null } | null;
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
    /** Presente sólo cuando se ancló a los libros: las tres cifras con las que
     *  se armó la línea de unidades sin CFDI, para poder auditarla. */
    ancla?: {
      costoDeVentasLibros: number;
      costoExplicadoPorCfdis: number;
      ingresoSinCfdiDeCompra: number;
    };
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
        // A público en general (XAXX010101000) y a extranjeros NO se les crea
        // Customer a propósito —un registro por comprador de mostrador ensucia
        // el catálogo y fusionarlos falsea la concentración de clientes— así
        // que `cliente` viene null y la venta se mostraba como «—» aunque el
        // CFDI SÍ trae el nombre en el receptor. Por eso se denormalizó
        // contraparteNombre: es el respaldo para nombrar la venta.
        ventaInvoice: { select: { contraparteNombre: true } },
        costos: { select: { monto: true } },
      },
    }),
    db.servicioVenta.findMany({
      where: { companyId, fecha: { gte: desde, lt: hasta } },
      select: { fecha: true, manoObra: true, refacciones: true },
    }),
    // Kardex de salidas del periodo, partido por origen: dentro de una orden
    // de taller vs mostrador. El costo va con el último costo conocido.
    // El costo sólo se aplica cuando ES COMPARABLE con lo que sale. Un
    // lubricante comprado por TAMBO (208 L) y vendido por LITRO tiene un
    // «último costo» 208 veces mayor que el costo de un litro: aplicarlo
    // convertía $29M de venta de refacciones en $868M de costo y un margen de
    // −2853%. Se descarta cuando la unidad del SAT de la compra difiere de la
    // de la venta, o —para filas aún sin unidad guardada— cuando el costo
    // supera al doble del precio, que en una refacción no ocurre por negocio.
    db.$queryRaw<
      Array<{ en_orden: boolean; ingreso: number; costo: number; piezas: number; ingreso_sin_costo: number }>
    >(Prisma.sql`
      WITH mov AS (
        SELECT m."invoiceId", m."cantidad", m."montoUnitario",
               (r."ultimoCosto" > 0
                AND (r."factorCosto" IS NOT NULL
                     OR ((r."unidadCosto" IS NULL OR r."unidadPrecio" IS NULL
                          OR r."unidadCosto" = r."unidadPrecio")
                         AND NOT (COALESCE(r."ultimoPrecio", 0) > 0
                                  AND r."ultimoCosto" > r."ultimoPrecio" * 2)))) AS comparable,
               -- Con factor, el costo se expresa en la unidad de VENTA. Sin
               -- factor vale tal cual, que es lo correcto cuando las unidades
               -- ya coinciden.
               r."ultimoCosto" / COALESCE(NULLIF(r."factorCosto", 0), 1) AS costo_unit
        FROM "RefaccionMovimiento" m
        JOIN "Refaccion" r ON r.id = m."refaccionId"
        WHERE r."companyId" = ${companyId}
          AND m."tipo" = 'SALIDA_VENTA'
          AND m."fecha" >= ${desde} AND m."fecha" < ${hasta}
      )
      SELECT EXISTS (SELECT 1 FROM "ServicioVenta" sv WHERE sv."invoiceId" = mov."invoiceId") AS en_orden,
             COALESCE(SUM(ABS("cantidad") * COALESCE("montoUnitario", 0)) FILTER (WHERE comparable), 0)::float8     AS ingreso,
             COALESCE(SUM(ABS("cantidad") * "costo_unit")             FILTER (WHERE comparable), 0)::float8       AS costo,
             COALESCE(SUM(ABS("cantidad") * COALESCE("montoUnitario", 0)) FILTER (WHERE NOT comparable), 0)::float8 AS ingreso_sin_costo,
             COALESCE(SUM(ABS("cantidad")), 0)::float8                                                              AS piezas
      FROM mov
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
    anclaCE: await anclaDeLibros(db, companyId, desde, hasta),
  });
}

/**
 * Costo de ventas del ejercicio SEGÚN LOS LIBROS, para anclar el tablero.
 *
 * Devuelve undefined —y entonces el tablero se queda exactamente como estaba—
 * salvo que se cumplan las dos condiciones que lo hacen correcto:
 *
 *   1. El periodo pedido es un EJERCICIO COMPLETO. El asiento de apertura es
 *      una FOTO a una fecha: su saldo de familia 5 es el costo acumulado del
 *      ejercicio que cierra, no el de un mes ni el de medio año. Aplicarlo a
 *      un trimestre daría un número seguro de sí mismo y equivocado, que es
 *      peor que no dar ninguno.
 *   2. Existe apertura importada que ampare justo ese ejercicio. La apertura se
 *      fecha el primer día del mes siguiente al de la balanza, así que la que
 *      cierra el ejercicio N cae en enero de N+1.
 *
 * La familia 5 es «costo de ventas» en el código agrupador del SAT — misma
 * convención para cualquier distribuidor, no algo afinado a esta agencia.
 */
async function anclaDeLibros(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date,
): Promise<{ costoDeVentas: number } | undefined> {
  const anio = desde.getUTCFullYear();
  const ejercicioCompleto =
    desde.getUTCMonth() === 0 &&
    desde.getUTCDate() === 1 &&
    hasta.getUTCFullYear() === anio + 1 &&
    hasta.getUTCMonth() === 0 &&
    hasta.getUTCDate() === 1;
  if (!ejercicioCompleto) return undefined;

  // `month: 1` NO es decorativo: es lo que ata la apertura al CIERRE del
  // ejercicio. La fecha de apertura es el primer día del mes SIGUIENTE al de la
  // balanza (fechaAperturaPorDefecto), así que sólo una balanza de DICIEMBRE de
  // N produce una apertura en enero de N+1 — y sólo ésa acumula el costo de
  // ventas del ejercicio completo.
  //
  // Sin este filtro, la apertura de MARGOM —que viene de la balanza de JUNIO de
  // 2026, o sea fechada 2026-07-01— empataba con `year: 2026` al pedir el
  // ejercicio 2025 y le colgaba a 2025 el costo acumulado de enero a junio de
  // 2026: $510,100,635.37 contra un costo de ventas propio de ~$1,732,595,264,
  // o sea un residuo de −$1,222,494,629. Un costo NEGATIVO de mil doscientos
  // millones se presenta como utilidad, y el tablero de 2025 mostraba mil
  // millones de ganancia inventada.
  const asientos = await db.accountingEntry.findMany({
    where: {
      companyId,
      fuente: "APERTURA",
      year: anio + 1,
      month: 1,
      chartAccount: { cuentaSAT: { startsWith: "5" } },
    },
    select: { monto: true, tipo: true },
  });
  if (asientos.length === 0) return undefined;

  const costoDeVentas = r2(
    asientos.reduce((s, a) => s + (a.tipo === "CARGO" ? a.monto : -a.monto), 0),
  );
  // Un costo de ventas negativo o en cero no es un ancla: es una señal de que
  // la apertura de esta empresa no trae la familia 5 como se espera. Mejor
  // dejar el tablero como estaba que colgarle un número sin sentido.
  return costoDeVentas > 0 ? { costoDeVentas } : undefined;
}

type NominaGrupo = {
  linea: string;
  _sum: { percepciones: number | null; cuotasPatronales: number | null };
  _count: { _all: number };
};

export interface InsumosResultados {
  unidades: UnidadVendida[];
  servicios: Array<{ fecha: Date; manoObra: number; refacciones: number }>;
  refaccionesRaw: Array<{
    en_orden: boolean; ingreso: number; costo: number; piezas: number; ingreso_sin_costo?: number;
  }>;
  nomina: NominaGrupo[];
  nominaPorSucursal: Array<{ sucursal: string | null; _sum: { percepciones: number | null; cuotasPatronales: number | null } }>;
  gastos: GastosResultado;
  otros?: OtrosIngresosResultado;
  /**
   * Ancla a los libros. Sin esto el tablero se queda como estaba: cuenta sólo
   * las unidades cuyo CFDI de compra tenemos y deja fuera el ingreso de las
   * demás — que es de donde salía la brecha de $188.1M contra la balanza.
   *
   * Con esto, las unidades sin CFDI de compra ENTRAN con su ingreso real (la
   * venta sí se facturó) y su costo se obtiene por DIFERENCIA contra el costo
   * de ventas de la balanza. Los dos lados quedan sobre los libros y el residuo
   * deja de ser un error invisible para volverse un renglón con nombre.
   */
  anclaCE?: {
    /** Costo de ventas del periodo según la balanza (familia 5). */
    costoDeVentas: number;
  };
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
  const vacio = { ingreso: 0, costo: 0, piezas: 0, ingreso_sin_costo: 0 };
  const refEnOrden = d.refaccionesRaw.find((r) => r.en_orden) ?? vacio;
  const refMostrador = d.refaccionesRaw.find((r) => !r.en_orden) ?? vacio;

  const lineaRefacciones = (
    fuente: { ingreso: number; costo: number; piezas: number; ingreso_sin_costo?: number },
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
    // Salidas cuyo costo no es comparable (unidad de compra ≠ unidad de venta):
    // quedan FUERA del margen y se reportan, como las unidades sin costo.
    ingresoSinCosto: r2(fuente.ingreso_sin_costo ?? 0),
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

  // ── Unidades sin CFDI de compra ────────────────────────────────────────────
  // Se vendieron y se facturaron, pero su compra no está en nuestro archivo:
  // o no se encontró, o es anterior a la ventana de visibilidad (2021). Hasta
  // ahora quedaban FUERA por los dos lados —ni ingreso ni costo—, que es de
  // donde salía la brecha contra la balanza: −$188.1M de ingreso y −$178.6M de
  // costo, casi cancelándose.
  //
  // Dejarlas fuera no es neutral: el ingreso ES real y está facturado. Entran
  // con su ingreso, y su costo sale por DIFERENCIA contra el costo de ventas de
  // los libros. Va en su PROPIA línea para que los márgenes de las demás sigan
  // siendo comparables y para que el residuo se vea, en vez de repartirlo a
  // prorrata sobre unidades que sí tienen su costo.
  const ingresoSinCFDI = r2(nuevas.ingresoSinCosto + seminuevas.ingresoSinCosto);
  if (d.anclaCE) {
    // Todo el costo que YA explicamos con CFDIs y que los libros meten en el
    // costo de ventas: unidades y refacciones. La mano de obra no — ésa vive en
    // nómina, no en la familia 5.
    const costoExplicado = r2(
      nuevas.costo +
        seminuevas.costo +
        (refEnOrden.costo ?? 0) +
        (refMostrador.costo ?? 0)
    );
    // El residuo puede salir negativo si los libros registran MENOS costo del
    // que ya atribuimos. Eso no es el costo de estas unidades: es un descuadre,
    // y se reporta como está en vez de recortarlo a cero y fingir que cuadra.
    const costoPorDiferencia = r2(d.anclaCE.costoDeVentas - costoExplicado);
    lineas.push({
      clave: "unidades_sin_cfdi_compra",
      nombre: "Unidades sin CFDI de compra (costo desde libros)",
      ingreso: ingresoSinCFDI,
      costo: costoPorDiferencia,
      utilidad: r2(ingresoSinCFDI - costoPorDiferencia),
      margen: margen(ingresoSinCFDI - costoPorDiferencia, ingresoSinCFDI),
      unidades: nuevas.sinCosto + seminuevas.sinCosto,
      costoEstimado: true,
      costoDesdeLibros: true,
    });
  }

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
      ingresoSinCosto: r2(
        // Con el ancla puesta, el ingreso de las unidades sin CFDI ya ENTRÓ en
        // su propia línea: seguir reportándolo aquí lo contaría dos veces para
        // quien lea este campo como «ingreso que se quedó fuera».
        (d.anclaCE ? 0 : nuevas.ingresoSinCosto + seminuevas.ingresoSinCosto) +
          (refEnOrden.ingreso_sin_costo ?? 0) +
          (refMostrador.ingreso_sin_costo ?? 0)
      ),
      ...(d.anclaCE
        ? {
            ancla: {
              costoDeVentasLibros: r2(d.anclaCE.costoDeVentas),
              costoExplicadoPorCfdis: r2(
                nuevas.costo + seminuevas.costo + (refEnOrden.costo ?? 0) + (refMostrador.costo ?? 0)
              ),
              ingresoSinCfdiDeCompra: ingresoSinCFDI,
            },
          }
        : {}),
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
  /**
   * Venta de refacciones cuyo costo NO es comparable (la unidad de compra
   * difiere de la de venta). Queda fuera del cálculo —arriba y abajo— porque
   * su margen no se puede afirmar; se reporta para que la absorción no parezca
   * más baja de lo que es sin explicar por qué.
   */
  ingresoSinCosto: number;
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
    // MISMA regla de comparabilidad que el estado de resultados. Sin ella, un
    // lubricante comprado por TAMBO (208 L) y vendido por LITRO trae un «último
    // costo» 208 veces mayor que el del litro que sale del kardex: en MARGOM
    // eso convertía $3.5M de venta de refacciones en $85M de costo y hundía la
    // absorción a −768%. El estado de resultados ya lo filtraba; esta serie no,
    // y por eso la tarjeta y la gráfica de la misma pantalla no coincidían.
    db.$queryRaw<Array<{ mes: Date; ingreso: number; costo: number; ingreso_sin_costo: number }>>(Prisma.sql`
      WITH mov AS (
        SELECT m."fecha", m."cantidad", m."montoUnitario",
               (r."ultimoCosto" > 0
                AND (r."factorCosto" IS NOT NULL
                     OR ((r."unidadCosto" IS NULL OR r."unidadPrecio" IS NULL
                          OR r."unidadCosto" = r."unidadPrecio")
                         AND NOT (COALESCE(r."ultimoPrecio", 0) > 0
                                  AND r."ultimoCosto" > r."ultimoPrecio" * 2)))) AS comparable,
               -- Con factor, el costo se expresa en la unidad de VENTA. Sin
               -- factor vale tal cual, que es lo correcto cuando las unidades
               -- ya coinciden.
               r."ultimoCosto" / COALESCE(NULLIF(r."factorCosto", 0), 1) AS costo_unit
        FROM "RefaccionMovimiento" m
        JOIN "Refaccion" r ON r.id = m."refaccionId"
        WHERE r."companyId" = ${companyId} AND m."tipo" = 'SALIDA_VENTA'
          AND m."fecha" >= ${desde} AND m."fecha" < ${hasta}
      )
      SELECT date_trunc('month', "fecha") AS mes,
             COALESCE(SUM(ABS("cantidad") * COALESCE("montoUnitario", 0)) FILTER (WHERE comparable), 0)::float8     AS ingreso,
             COALESCE(SUM(ABS("cantidad") * "costo_unit")               FILTER (WHERE comparable), 0)::float8     AS costo,
             COALESCE(SUM(ABS("cantidad") * COALESCE("montoUnitario", 0)) FILTER (WHERE NOT comparable), 0)::float8 AS ingreso_sin_costo
      FROM mov
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
    if (!f) meses.set(k, (f = { mes: k, utilidadFixedOps: 0, estructura: 0, porcentaje: null, ingresoSinCosto: 0 }));
    return f;
  };

  for (const r of manoObra) fila(r.mes).utilidadFixedOps += r.valor;
  for (const r of refacciones) {
    const f = fila(r.mes);
    f.utilidadFixedOps += r.ingreso - r.costo;
    f.ingresoSinCosto += r.ingreso_sin_costo;
  }
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
      ingresoSinCosto: r2(f.ingresoSinCosto),
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
