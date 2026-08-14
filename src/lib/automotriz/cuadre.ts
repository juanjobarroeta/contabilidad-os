// ─────────────────────────────────────────────────────────────────────────────
// CUADRE DE CFDIs — ¿cada peso facturado está contado exactamente una vez?
//
// El tablero reparte cada CFDI de egreso en cubetas: compra de unidad, costo de
// unidad, entrada de refacciones, y lo que sobra es gasto de operación. Nadie
// verificaba dos cosas que ese reparto da por hechas:
//
//   1. NO SOBRE-ATRIBUCIÓN — lo que se le carga a una factura no puede valer
//      más que la factura. Un caso real: un CFDI de $25,810,344.83 por
//      «Conversión y Equipamiento para 30 vehiculos» generó una fila de costo
//      de $25,810,344.82 sobre UNA sola unidad (que se vendió en $1,711,000) y
//      además filas de $1,720,689.65 —el subtotal entre 15— sobre las otras.
//      Dos divisores distintos en la misma factura: alguno está mal, y el costo
//      inflado sale del margen de esa unidad.
//
//   2. NADA SE PIERDE — gastosDeOperacion excluye la factura entera cuando
//      tiene CUALQUIER liga (`vehiculosComprados: { none: {} }` y sus dos
//      hermanas). Así que una factura atribuida A MEDIAS sale COMPLETA del
//      gasto, y el remanente no atribuido no lo cuenta nadie. Cada CFDI
//      parcialmente ligado pierde su residuo en silencio.
//
// Este módulo no arregla nada: MIDE. Devuelve, por empresa y periodo, cuánto
// dinero está sobre-atribuido, cuánto se pierde en residuos y cuánto llega
// legítimamente al gasto — y los totales tienen que sumar el subtotal facturado.
// La regla es estructural (documento contra atribuciones), no depende del texto
// del CFDI ni del giro de la agencia, así que vale igual para cualquier
// distribuidor.
// ─────────────────────────────────────────────────────────────────────────────

import type { PrismaClient } from "@prisma/client";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Centavo de tolerancia: los importes del CFDI vienen redondeados a 2. */
const TOL = 0.01;

export interface FacturaDescuadrada {
  invoiceId: string;
  subtotal: number;
  atribuido: number;
  diferencia: number;
  /** Cuántas unidades distintas reclaman dinero de esta factura. */
  unidades: number;
  concepto: string | null;
}

export interface CuadreLado {
  facturas: number;
  subtotal: number;
  /** Facturas sin liga alguna: su importe completo va al gasto/ingreso general. */
  sinAtribuir: { facturas: number; monto: number };
  /** Facturas atribuidas por completo (dentro de la tolerancia). */
  completas: { facturas: number; monto: number };
  /**
   * Atribuidas a medias. `residuo` es el dinero que HOY no cuenta nadie: la
   * factura sale del gasto por tener liga, pero sólo parte se atribuyó.
   */
  parciales: { facturas: number; atribuido: number; residuo: number };
  /** Se le cargó MÁS de lo que vale. `exceso` es dinero inventado. */
  sobreAtribuidas: { facturas: number; exceso: number; peores: FacturaDescuadrada[] };
}

export interface CuadreResultado {
  companyId: string;
  desde: string;
  hasta: string;
  egreso: CuadreLado;
  /** El cuadre debe cerrar: sinAtribuir + completas + parciales.atribuido + residuo = subtotal. */
  cuadra: boolean;
}

interface Atribucion {
  monto: number;
  unidades: Set<string>;
  concepto: string | null;
}

/**
 * Suma, por factura, todo lo que el sistema le ha cargado: el costo de compra
 * de las unidades que ampara, los VehiculoCosto que cuelgan de ella y las
 * entradas de refacciones que la citan.
 *
 * Las notas de crédito de proveedor entran con monto NEGATIVO (netean el
 * costo), así que la suma es algebraica a propósito.
 */
async function atribucionesPorFactura(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date,
): Promise<Map<string, Atribucion>> {
  const acc = new Map<string, Atribucion>();
  const suma = (id: string, monto: number, vehiculoId: string | null, concepto: string | null) => {
    const a = acc.get(id) ?? { monto: 0, unidades: new Set<string>(), concepto: null };
    a.monto += monto;
    if (vehiculoId) a.unidades.add(vehiculoId);
    // Se guarda el concepto del cargo más grande: es el que explica el descuadre.
    if (a.concepto == null && concepto) a.concepto = concepto;
    acc.set(id, a);
  };

  // 1. Compra de unidad: el costo que la unidad tomó de su CFDI de compra.
  const compras = await db.vehiculo.findMany({
    where: { companyId, compraInvoiceId: { not: null }, compraInvoice: { fecha: { gte: desde, lt: hasta } } },
    select: { id: true, compraInvoiceId: true, costoCompra: true, descripcionCfdi: true },
  });
  for (const v of compras) {
    if (v.compraInvoiceId) suma(v.compraInvoiceId, v.costoCompra, v.id, v.descripcionCfdi);
  }

  // 2. Costos que cuelgan de una factura (accesorios, traslado, conversión, NC).
  const costos = await db.vehiculoCosto.findMany({
    where: { invoiceId: { not: null }, vehiculo: { companyId }, invoice: { fecha: { gte: desde, lt: hasta } } },
    select: { invoiceId: true, vehiculoId: true, monto: true, concepto: true },
    orderBy: { monto: "desc" },
  });
  for (const c of costos) {
    if (c.invoiceId) suma(c.invoiceId, c.monto, c.vehiculoId, c.concepto);
  }

  // 3. Entradas de refacciones (cantidad positiva = entrada al kardex).
  const movs = await db.refaccionMovimiento.findMany({
    where: {
      invoiceId: { not: null },
      refaccion: { companyId },
      invoice: { fecha: { gte: desde, lt: hasta } },
      cantidad: { gt: 0 },
    },
    select: { invoiceId: true, cantidad: true, montoUnitario: true },
  });
  for (const m of movs) {
    if (m.invoiceId) suma(m.invoiceId, m.cantidad * (m.montoUnitario ?? 0), null, null);
  }

  return acc;
}

/**
 * Cuadre del lado del EGRESO para una empresa y periodo. Sólo lee.
 */
export async function cuadreDeCfdis(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date,
  opts: { peores?: number } = {},
): Promise<CuadreResultado> {
  const facturas = await db.invoice.findMany({
    where: {
      companyId,
      tipo: "EGRESO",
      status: { not: "CANCELLED" },
      fecha: { gte: desde, lt: hasta },
    },
    select: { id: true, subtotal: true, tipoSat: true },
  });

  const atribuciones = await atribucionesPorFactura(db, companyId, desde, hasta);

  let subtotal = 0;
  let sinAtribuirN = 0;
  let sinAtribuirM = 0;
  let completasN = 0;
  let completasM = 0;
  let parcialesN = 0;
  let parcialesAtribuido = 0;
  let parcialesResiduo = 0;
  let sobreN = 0;
  let sobreExceso = 0;
  const peores: FacturaDescuadrada[] = [];

  for (const f of facturas) {
    // Una nota de crédito recibida vale en negativo; el cuadre la compara
    // contra su propia magnitud para no llamar «sobre-atribuida» a una NC.
    const valor = (f.tipoSat ?? "I") === "E" ? -Math.abs(f.subtotal) : f.subtotal;
    subtotal = r2(subtotal + valor);

    const a = atribuciones.get(f.id);
    if (!a || Math.abs(a.monto) < TOL) {
      sinAtribuirN++;
      sinAtribuirM = r2(sinAtribuirM + valor);
      continue;
    }

    const diferencia = r2(a.monto - valor);
    if (diferencia > TOL) {
      sobreN++;
      sobreExceso = r2(sobreExceso + diferencia);
      peores.push({
        invoiceId: f.id,
        subtotal: r2(valor),
        atribuido: r2(a.monto),
        diferencia,
        unidades: a.unidades.size,
        concepto: a.concepto?.slice(0, 80) ?? null,
      });
      continue;
    }
    if (diferencia < -TOL) {
      parcialesN++;
      parcialesAtribuido = r2(parcialesAtribuido + a.monto);
      // Lo que la factura vale de más que lo atribuido: hoy no lo cuenta nadie,
      // porque gastosDeOperacion la excluye entera por tener liga.
      parcialesResiduo = r2(parcialesResiduo + (valor - a.monto));
      continue;
    }
    completasN++;
    completasM = r2(completasM + a.monto);
  }

  peores.sort((x, y) => y.diferencia - x.diferencia);

  const sumaPartes = r2(sinAtribuirM + completasM + parcialesAtribuido + parcialesResiduo);
  return {
    companyId,
    desde: desde.toISOString().slice(0, 10),
    hasta: hasta.toISOString().slice(0, 10),
    egreso: {
      facturas: facturas.length,
      subtotal,
      sinAtribuir: { facturas: sinAtribuirN, monto: sinAtribuirM },
      completas: { facturas: completasN, monto: completasM },
      parciales: { facturas: parcialesN, atribuido: parcialesAtribuido, residuo: parcialesResiduo },
      sobreAtribuidas: {
        facturas: sobreN,
        exceso: sobreExceso,
        peores: peores.slice(0, opts.peores ?? 15),
      },
    },
    // El exceso queda FUERA de la identidad: es dinero que no existe en ningún
    // CFDI, así que si el cuadre cierra sin él, cerró.
    cuadra: Math.abs(sumaPartes - subtotal) < 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CUADRE DEL INGRESO — ¿qué CFDI de venta no lo reclama nadie?
//
// El gasto y el ingreso se calculan al revés uno del otro, y por eso uno está
// completo y el otro no:
//
//   • gastosDeOperacion toma TODOS los EGRESO y los clasifica. Nada se pierde:
//     lo que no cae en una cuenta cae en «Otros gastos».
//   • El ingreso NO se suma de los CFDIs. Sale de `Vehiculo.precioVenta` (y
//     sólo de las unidades con costo de compra conocido), de `ServicioVenta`, y
//     de otrosIngresos —que además sólo mira claves 8014%—. Un CFDI de venta
//     que ningún derivador reclama no se va a otro renglón: NO SE CUENTA.
//
// Por eso «tenemos todos los CFDIs» y aun así el ingreso queda corto: tener el
// documento no es lo mismo que reconocerlo. Esto mide exactamente cuánto se
// queda sin reclamar, y con qué claves, que es lo que dice qué derivador falta.
// ─────────────────────────────────────────────────────────────────────────────

/** Anticipo del bien o servicio (Anexo 20): cobro a cuenta, no ingreso. */
const CLAVE_ANTICIPO_INGRESO = "84111506";

export interface CuadreIngreso {
  facturas: number;
  subtotal: number;
  ventaDeUnidad: { facturas: number; monto: number };
  servicio: { facturas: number; monto: number };
  otrosIngresos: { facturas: number; monto: number };
  anticipos: { facturas: number; monto: number };
  notasDeCredito: { facturas: number; monto: number };
  /** Lo que ningún derivador reclama — el ingreso que el tablero no ve. */
  sinReclamar: {
    facturas: number;
    monto: number;
    porClave: Array<{ clave: string; monto: number; facturas: number; ejemplo: string | null }>;
  };
  /**
   * Cómo se aplican los anticipos, que es lo que decide si el tablero los está
   * perdiendo o no. El Anexo 20 admite dos esquemas:
   *
   *   A) anticipo $X → CFDI por el TOTAL $Y (relación 07) → nota de crédito $X
   *      Neto = $Y. El tablero YA acierta: excluye anticipo y NC, cuenta $Y.
   *   B) anticipo $X → CFDI sólo por el REMANENTE $Y−$X (relación 07)
   *      Neto = $Y. El tablero se queda corto por $X.
   *
   * Los totales permiten los dos (anticipos $253.1M contra NC $272.4M), así que
   * hay que mirar las relaciones. Un CFDI que aplica anticipo lleva
   * TipoRelacion 07; si además existe la NC por el mismo importe, es el
   * esquema A.
   */
  relaciones: Array<{
    tipoRelacion: string;
    facturas: number;
    monto: number;
    /**
     * Del total de arriba, cuánto es CFDI de EGRESO (tipoSat "E", nota de
     * crédito). Es el número que decide el esquema de anticipo del Anexo 20:
     *
     *   • Si el grueso del bucket 07 es EGRESO, son las notas de crédito que
     *     CANCELAN el anticipo — esquema A, donde el CFDI de venta ya ampara
     *     el total y el tablero acierta al excluir anticipo y NC.
     *   • Si el grueso es INGRESO por importes pequeños, son facturas por el
     *     REMANENTE — esquema B, y entonces el tablero se queda corto por el
     *     anticipo que nunca se sumó.
     *
     * Sin este corte los dos esquemas se ven igual en el agregado.
     */
    egreso: { facturas: number; monto: number };
  }>;
  /**
   * Relaciones leídas del XML, no de la columna.
   *
   * `Invoice.tipoRelacion` sólo lo escribe nota-credito.ts, que es el módulo
   * que EMITE notas de crédito desde la app. Nada lo puebla al importar del
   * SAT: medido, las 27,336 facturas de ingreso de MARGOM lo tienen en null,
   * incluidas 6,129 notas de crédito y 5,052 anticipos. El campo existe para
   * las facturas que la app genera, no para las que ingiere.
   *
   * La relación sí viene en el CFDI (`CfdiRelacionados TipoRelacion=…`), así
   * que se pregunta al XML. Es lo único que puede decir cuál de los dos
   * esquemas de anticipo del Anexo 20 usan, y por lo tanto si el tablero está
   * perdiendo ~$155M o ya acierta.
   */
  relacionesEnXml: Array<{ tipoRelacion: string; facturas: number; monto: number }>;
}

export async function cuadreDeIngresos(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date,
): Promise<CuadreIngreso> {
  const facturas = await db.invoice.findMany({
    where: { companyId, tipo: "INGRESO", status: { not: "CANCELLED" }, fecha: { gte: desde, lt: hasta } },
    select: {
      id: true,
      subtotal: true,
      tipoSat: true,
      tipoRelacion: true,
      items: { select: { claveProdServ: true, importe: true, descripcion: true } },
      vehiculosVendidos: { select: { id: true }, take: 1 },
      servicioVenta: { select: { id: true } },
    },
  });

  const b = () => ({ facturas: 0, monto: 0 });
  const res: CuadreIngreso = {
    facturas: facturas.length,
    subtotal: 0,
    ventaDeUnidad: b(),
    servicio: b(),
    otrosIngresos: b(),
    anticipos: b(),
    notasDeCredito: b(),
    sinReclamar: { facturas: 0, monto: 0, porClave: [] },
    relaciones: [],
    relacionesEnXml: [],
  };
  const porClave = new Map<string, { monto: number; facturas: number; ejemplo: string | null }>();
  const porRelacion = new Map<
    string,
    { facturas: number; monto: number; egreso: { facturas: number; monto: number } }
  >();

  for (const f of facturas) {
    res.subtotal = r2(res.subtotal + f.subtotal);
    // Cadena vacía = el barrido de relaciones-backfill ya miró este CFDI y su
    // nodo CfdiRelacionados no rindió un par (tipo, uuid) usable. Para este
    // reporte es lo mismo que no traer relación; sin esto aparecería un
    // renglón con clave vacía que no significa nada para quien lo lee.
    const rel = f.tipoRelacion ? f.tipoRelacion : "(sin relación)";
    const pr = porRelacion.get(rel) ?? { facturas: 0, monto: 0, egreso: { facturas: 0, monto: 0 } };
    pr.facturas++;
    pr.monto = r2(pr.monto + f.subtotal);
    if ((f.tipoSat ?? "I") === "E") {
      pr.egreso.facturas++;
      pr.egreso.monto = r2(pr.egreso.monto + f.subtotal);
    }
    porRelacion.set(rel, pr);
    // La clave DOMINANTE decide, igual que en el gasto.
    const dom = [...f.items].sort((a, b2) => b2.importe - a.importe)[0];
    const clave = dom?.claveProdServ ?? "";

    const meter = (k: { facturas: number; monto: number }) => {
      k.facturas++;
      k.monto = r2(k.monto + f.subtotal);
    };

    if ((f.tipoSat ?? "I") === "E") meter(res.notasDeCredito);
    else if (f.vehiculosVendidos.length > 0) meter(res.ventaDeUnidad);
    else if (f.servicioVenta) meter(res.servicio);
    else if (clave === CLAVE_ANTICIPO_INGRESO) meter(res.anticipos);
    else if (clave.startsWith("8014")) meter(res.otrosIngresos);
    else {
      meter(res.sinReclamar);
      const k = porClave.get(clave) ?? { monto: 0, facturas: 0, ejemplo: null };
      k.monto = r2(k.monto + f.subtotal);
      k.facturas++;
      if (k.ejemplo == null && dom?.descripcion) k.ejemplo = dom.descripcion.slice(0, 70);
      porClave.set(clave, k);
    }
  }

  // Las relaciones que de verdad trae el CFDI. Se cuentan en la base con
  // `contains` para no traerse 27 mil rawXml a memoria.
  //   01 nota de crédito · 04 sustitución · 07 aplicación de anticipo
  const TIPOS = ["01", "02", "03", "04", "05", "06", "07"] as const;
  const enXml: Array<{ tipoRelacion: string; facturas: number; monto: number }> = [];
  for (const t of TIPOS) {
    const where = {
      companyId,
      tipo: "INGRESO" as const,
      status: { not: "CANCELLED" as const },
      fecha: { gte: desde, lt: hasta },
      rawXml: { contains: `TipoRelacion="${t}"` },
    };
    const [n, agg] = await Promise.all([
      db.invoice.count({ where }),
      db.invoice.aggregate({ where, _sum: { subtotal: true } }),
    ]);
    if (n > 0) enXml.push({ tipoRelacion: t, facturas: n, monto: r2(agg._sum.subtotal ?? 0) });
  }
  res.relacionesEnXml = enXml.sort((a, b2) => b2.monto - a.monto);

  res.relaciones = [...porRelacion.entries()]
    .map(([tipoRelacion, v]) => ({ tipoRelacion, ...v }))
    .sort((a, b2) => b2.monto - a.monto);
  res.sinReclamar.porClave = [...porClave.entries()]
    .map(([clave, v]) => ({ clave, ...v }))
    .sort((a, b2) => b2.monto - a.monto)
    .slice(0, 20);
  return res;
}
