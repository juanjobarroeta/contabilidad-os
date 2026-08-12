// ─────────────────────────────────────────────────────────────────────────────
// Invariantes duros: lo que el tablero afirma y es ARITMÉTICAMENTE imposible.
//
// Las bandas de `senales.ts` dicen «esto se ve mal» y se pueden discutir: un
// distribuidor puede sostener que su margen de mano de obra sí llega a 90%.
// Lo de aquí no se discute. Un objeto derivado de UN CFDI no puede valer más
// que ese CFDI. Si vale más, el derivador contó algo dos veces — punto.
//
// El caso que lo motivó: mano de obra de taller reportando $317,190,852 sobre
// 10,286 órdenes ($30,838 por orden) mientras la suma de los conceptos de esos
// mismos CFDIs daba un orden de magnitud menos. Con la banda de margen sólo se
// podía decir «parece alto». Con este cheque se dice exactamente cuántos pesos
// sobran y en qué facturas — y eso sí se puede arreglar.
//
// Estos cheques valen más que cualquier heurística porque:
//   • No tienen falsos positivos que dependan del giro del negocio.
//   • Señalan el documento exacto, no una línea agregada.
//   • Habrían disparado el DÍA UNO en que corrió el derivador, sin que nadie
//     tuviera que sospechar nada ni mirar el reporte con ojo crítico.
//
// Igual que el resto del motor: esto NO corrige nada. Reporta.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from "@prisma/client";

/**
 * Tolerancia en pesos. El CFDI trae los importes redondeados a dos decimales y
 * la suma de conceptos puede diferir del subtotal por centavos legítimos; un
 * peso de holgura evita reportar ruido de redondeo como si fuera un defecto.
 */
const TOLERANCIA = 1;

export interface Violacion {
  /** Identificador del cheque, estable para poder seguirlo entre corridas. */
  clave: string;
  titulo: string;
  /** Qué es imposible, en una frase, sin jerga. */
  explicacion: string;
  documentos: number;
  /** Pesos que sobran respecto de lo que el CFDI ampara. */
  exceso: number;
  /** Los peores casos, para poder abrir uno y ver qué pasó. */
  ejemplos: Array<{
    invoiceId: string;
    referencia: string;
    fecha: Date | null;
    derivado: number;
    cfdi: number;
    veces: number | null;
  }>;
}

interface FilaViolacion {
  invoice_id: string;
  serie: string | null;
  folio: string | null;
  fecha: Date | null;
  derivado: number;
  cfdi: number;
}

interface ResumenViolacion {
  documentos: number;
  exceso: number;
}

/**
 * ServicioVenta no puede valer más que su CFDI. `manoObra + refacciones` salen
 * de los conceptos del propio comprobante, así que su suma está acotada por el
 * subtotal — si lo excede, se contaron conceptos repetidos.
 */
async function servicioSobreCfdi(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<Violacion | null> {
  const condicion = Prisma.sql`
    FROM "ServicioVenta" s
    JOIN "Invoice" i ON i.id = s."invoiceId"
    WHERE s."companyId" = ${companyId}
      AND s."fecha" >= ${desde} AND s."fecha" < ${hasta}
      AND i."status" <> 'CANCELLED'
      AND (s."manoObra" + s."refacciones") > i."subtotal" + ${TOLERANCIA}
  `;

  const [resumen] = await db.$queryRaw<ResumenViolacion[]>(Prisma.sql`
    SELECT COUNT(*)::int AS documentos,
           COALESCE(SUM((s."manoObra" + s."refacciones") - i."subtotal"), 0)::float8 AS exceso
    ${condicion}
  `);
  if (!resumen || resumen.documentos === 0) return null;

  const ejemplos = await db.$queryRaw<FilaViolacion[]>(Prisma.sql`
    SELECT s."invoiceId" AS invoice_id, i."serie", i."folio", i."fecha",
           (s."manoObra" + s."refacciones")::float8 AS derivado,
           i."subtotal"::float8 AS cfdi
    ${condicion}
    ORDER BY ((s."manoObra" + s."refacciones") - i."subtotal") DESC
    LIMIT 10
  `);

  return {
    clave: "servicio_excede_cfdi",
    titulo: "Órdenes de servicio que valen más que su propia factura",
    explicacion:
      "La mano de obra y las refacciones de una orden salen de los conceptos de su CFDI, así que no pueden sumar más que el subtotal de ese CFDI. Cuando lo exceden, el derivador leyó conceptos repetidos — normalmente porque el XML trae el bloque de conceptos dos veces (addenda o complemento duplicado).",
    documentos: resumen.documentos,
    exceso: redondear(resumen.exceso),
    ejemplos: ejemplos.map(aEjemplo),
  };
}

/**
 * El kardex tampoco puede valer más que el CFDI que lo ampara: las salidas de
 * refacciones de una factura suman, como mucho, el subtotal de esa factura.
 */
async function kardexSobreCfdi(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<Violacion | null> {
  const condicion = Prisma.sql`
    FROM (
      SELECT m."invoiceId",
             SUM(ABS(m."cantidad") * COALESCE(m."montoUnitario", 0)) AS derivado
      FROM "RefaccionMovimiento" m
      JOIN "Refaccion" r ON r.id = m."refaccionId"
      WHERE r."companyId" = ${companyId}
        AND m."tipo" = 'SALIDA_VENTA'
        AND m."invoiceId" IS NOT NULL
        AND m."fecha" >= ${desde} AND m."fecha" < ${hasta}
      GROUP BY m."invoiceId"
    ) k
    JOIN "Invoice" i ON i.id = k."invoiceId"
    WHERE i."status" <> 'CANCELLED'
      AND k.derivado > i."subtotal" + ${TOLERANCIA}
  `;

  const [resumen] = await db.$queryRaw<ResumenViolacion[]>(Prisma.sql`
    SELECT COUNT(*)::int AS documentos,
           COALESCE(SUM(k.derivado - i."subtotal"), 0)::float8 AS exceso
    ${condicion}
  `);
  if (!resumen || resumen.documentos === 0) return null;

  const ejemplos = await db.$queryRaw<FilaViolacion[]>(Prisma.sql`
    SELECT k."invoiceId" AS invoice_id, i."serie", i."folio", i."fecha",
           k.derivado::float8 AS derivado, i."subtotal"::float8 AS cfdi
    ${condicion}
    ORDER BY (k.derivado - i."subtotal") DESC
    LIMIT 10
  `);

  return {
    clave: "kardex_excede_cfdi",
    titulo: "Salidas de refacciones que valen más que su factura",
    explicacion:
      "Las piezas que salen del inventario contra una factura no pueden valer más que esa factura. Cuando la exceden, o se duplicaron los movimientos, o la cantidad del movimiento está en una unidad distinta a la del precio (el caso del tambo vendido por litro).",
    documentos: resumen.documentos,
    exceso: redondear(resumen.exceso),
    ejemplos: ejemplos.map(aEjemplo),
  };
}

/**
 * La venta de una unidad no puede exceder el CFDI que la ampara. Detecta la
 * unidad ligada a la factura equivocada tras una refacturación.
 */
async function unidadSobreCfdi(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<Violacion | null> {
  const condicion = Prisma.sql`
    FROM (
      SELECT v."ventaInvoiceId" AS "invoiceId", SUM(COALESCE(v."precioVenta", 0)) AS derivado
      FROM "Vehiculo" v
      WHERE v."companyId" = ${companyId}
        AND v."ventaInvoiceId" IS NOT NULL
        AND v."fechaVenta" >= ${desde} AND v."fechaVenta" < ${hasta}
      GROUP BY v."ventaInvoiceId"
    ) u
    JOIN "Invoice" i ON i.id = u."invoiceId"
    WHERE i."status" <> 'CANCELLED'
      AND u.derivado > i."subtotal" + ${TOLERANCIA}
  `;

  const [resumen] = await db.$queryRaw<ResumenViolacion[]>(Prisma.sql`
    SELECT COUNT(*)::int AS documentos,
           COALESCE(SUM(u.derivado - i."subtotal"), 0)::float8 AS exceso
    ${condicion}
  `);
  if (!resumen || resumen.documentos === 0) return null;

  const ejemplos = await db.$queryRaw<FilaViolacion[]>(Prisma.sql`
    SELECT u."invoiceId" AS invoice_id, i."serie", i."folio", i."fecha",
           u.derivado::float8 AS derivado, i."subtotal"::float8 AS cfdi
    ${condicion}
    ORDER BY (u.derivado - i."subtotal") DESC
    LIMIT 10
  `);

  return {
    clave: "unidad_excede_cfdi",
    titulo: "Unidades vendidas por encima de su factura",
    explicacion:
      "El precio de venta registrado de las unidades ligadas a una factura no puede superar el subtotal de esa factura. Suele significar que la unidad quedó ligada a la factura equivocada después de una refacturación, o que varias unidades apuntan al mismo CFDI.",
    documentos: resumen.documentos,
    exceso: redondear(resumen.exceso),
    ejemplos: ejemplos.map(aEjemplo),
  };
}

/**
 * El cheque que los otros no pueden hacer: la SUMA de todo lo que reclama un
 * mismo CFDI, a través de sistemas distintos.
 *
 * Un concepto con número de parte Y clave de servicio (7818xx) lo toma el
 * derivador de taller como mano de obra y el del kardex como venta de refacción.
 * Cada uno, por separado, respeta el subtotal — así que `servicio_excede_cfdi`
 * y `kardex_excede_cfdi` dan limpio — pero el estado de resultados cuenta el
 * mismo peso dos veces, en dos líneas distintas. Sólo se ve sumándolos.
 */
async function sumaDerivadosSobreCfdi(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<Violacion | null> {
  const condicion = Prisma.sql`
    FROM "Invoice" i
    JOIN LATERAL (
      SELECT COALESCE(SUM(s."manoObra" + s."refacciones"), 0) AS monto
      FROM "ServicioVenta" s WHERE s."invoiceId" = i.id
    ) sv ON TRUE
    JOIN LATERAL (
      SELECT COALESCE(SUM(ABS(m."cantidad") * COALESCE(m."montoUnitario", 0)), 0) AS monto
      FROM "RefaccionMovimiento" m
      WHERE m."invoiceId" = i.id AND m."tipo" = 'SALIDA_VENTA'
    ) kx ON TRUE
    JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(v."precioVenta", 0)), 0) AS monto
      FROM "Vehiculo" v WHERE v."ventaInvoiceId" = i.id
    ) vh ON TRUE
    WHERE i."companyId" = ${companyId}
      AND i."tipo" = 'INGRESO'
      AND i."status" <> 'CANCELLED'
      AND i."fecha" >= ${desde} AND i."fecha" < ${hasta}
      AND (sv.monto + kx.monto + vh.monto) > i."subtotal" + ${TOLERANCIA}
  `;

  const [resumen] = await db.$queryRaw<ResumenViolacion[]>(Prisma.sql`
    SELECT COUNT(*)::int AS documentos,
           COALESCE(SUM((sv.monto + kx.monto + vh.monto) - i."subtotal"), 0)::float8 AS exceso
    ${condicion}
  `);
  if (!resumen || resumen.documentos === 0) return null;

  const ejemplos = await db.$queryRaw<FilaViolacion[]>(Prisma.sql`
    SELECT i.id AS invoice_id, i."serie", i."folio", i."fecha",
           (sv.monto + kx.monto + vh.monto)::float8 AS derivado,
           i."subtotal"::float8 AS cfdi
    ${condicion}
    ORDER BY ((sv.monto + kx.monto + vh.monto) - i."subtotal") DESC
    LIMIT 10
  `);

  return {
    clave: "suma_derivados_excede_cfdi",
    titulo: "CFDIs contados dos veces entre líneas del tablero",
    explicacion:
      "Sumando TODO lo que reclama esta factura —mano de obra, refacciones del kardex y unidades vendidas— se pasa de su propio subtotal. El mismo peso está apareciendo en dos líneas del estado de resultados a la vez. Pasa cuando un concepto trae número de parte y clave de servicio al mismo tiempo: el derivador de taller lo cuenta como mano de obra y el del kardex como refacción.",
    documentos: resumen.documentos,
    exceso: redondear(resumen.exceso),
    ejemplos: ejemplos.map(aEjemplo),
  };
}

function aEjemplo(f: FilaViolacion) {
  return {
    invoiceId: f.invoice_id,
    referencia: [f.serie, f.folio].filter(Boolean).join("-") || f.invoice_id.slice(-8),
    fecha: f.fecha,
    derivado: redondear(f.derivado),
    cfdi: redondear(f.cfdi),
    veces: f.cfdi > 0 ? Math.round((f.derivado / f.cfdi) * 10) / 10 : null,
  };
}

const redondear = (n: number) => Math.round(n * 100) / 100;

/**
 * Corre todos los cheques del periodo. Devuelve sólo los que encontraron algo:
 * una lista vacía es la respuesta buena y se debe poder leer de un vistazo.
 */
export async function invariantes(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<Violacion[]> {
  const resultados = await Promise.all([
    servicioSobreCfdi(db, companyId, desde, hasta),
    kardexSobreCfdi(db, companyId, desde, hasta),
    unidadSobreCfdi(db, companyId, desde, hasta),
    sumaDerivadosSobreCfdi(db, companyId, desde, hasta),
  ]);
  return resultados
    .filter((v): v is Violacion => v !== null)
    .sort((a, b) => b.exceso - a.exceso);
}
