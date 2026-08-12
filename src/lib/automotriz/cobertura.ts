// ─────────────────────────────────────────────────────────────────────────────
// Cobertura del archivo: ¿qué parte de lo facturado SÍ está explicada?
//
// El estado de resultados suma lo que encontró. Este reporte hace la pregunta
// contraria —la única que detecta lo que falta— y la hace en pesos:
//
//     Σ subtotal de los CFDIs del periodo
//   − Σ lo que reclama algún objeto derivado (unidad, orden, kardex, recibo)
//   − Σ lo que clasifica una regla (del catálogo o confirmada por la agencia)
//   ─────────────────────────────────────────────────────────────────────────
//   = RESIDUO: dinero facturado que ninguna línea del tablero está contando
//
// El residuo es el producto. Los dos errores caros de Margom habrían salido de
// aquí el primer día, sin que nadie sospechara nada:
//
//   • ~$97M de bonos del distribuidor y comisiones de seguros que no aparecían
//     en NINGUNA línea del estado de resultados — el residuo los habría listado
//     como el cluster más grande del ejercicio.
//   • Los CFDIs de lubricante comprados por tambo y vendidos por litro: el
//     residuo no los detecta (están clasificados), pero el mismo reporte compara
//     la unidad de compra contra la de venta y los marca como no costeables.
//
// La regla de oro del reporte: NUNCA repartir el residuo «a ojo» entre las
// líneas conocidas. Un renglón honesto de sobras vale más que una precisión
// inventada — y es lo que hace que valga la pena revisarlo.
//
// El residuo se entrega AGRUPADO, no factura por factura: 38 mil conceptos
// sueltos no son accionables, pero los ~300 clusters que forman (misma clave +
// misma descripción salvo números) sí, y los 30 primeros por peso concentran
// casi todo el dinero. Ése es el orden de trabajo del onboarding: se confirma un
// cluster, nace una regla, y el residuo baja de golpe.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma, type PrismaClient } from "@prisma/client";
import { classifyEgreso } from "@/lib/contabilidad/classify-egreso";
import { COE_CODES } from "@/lib/contabilidad/catalog";
import { clasificarIngreso } from "./otros-ingresos";
import { aplicarReglas, prepararReglas, type ReglaAplicable, type ReglaPreparada } from "./reglas";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Anticipo del bien o servicio: no es venta, se netea contra su egreso. */
const CLAVE_ANTICIPO = "84111506";

export type BucketCobertura =
  | "unidad_venta"
  | "unidad_compra"
  | "unidad_costo"
  | "servicio"
  | "refaccion_venta"
  | "refaccion_compra"
  | "nomina"
  | "anticipo"
  | "otros_ingresos"
  | "gasto"
  | "pendiente";

export const NOMBRE_BUCKET: Record<BucketCobertura, string> = {
  unidad_venta: "Venta de unidades",
  unidad_compra: "Compra de unidades",
  unidad_costo: "Costos atribuidos a una unidad",
  servicio: "Órdenes de servicio",
  refaccion_venta: "Venta de refacciones",
  refaccion_compra: "Compra de refacciones",
  nomina: "Nómina",
  anticipo: "Anticipos (se netean)",
  otros_ingresos: "Bonos, comisiones y otros ingresos",
  gasto: "Gastos de operación",
  pendiente: "Sin clasificar",
};

/** Buckets que provienen de un objeto derivado, no de una regla de texto. */
const DERIVADOS = new Set<string>([
  "unidad_venta",
  "unidad_compra",
  "unidad_costo",
  "servicio",
  "refaccion_venta",
  "refaccion_compra",
  "nomina",
]);

/** Fila cruda: un grupo de CFDIs que comparten bucket derivado, o un cluster. */
export interface FilaCobertura {
  bucket: string;
  tipo: string;
  clave: string;
  patron: string;
  muestra: string | null;
  facturas: number;
  monto: number;
}

export interface ClusterPendiente {
  tipo: string;
  clave: string;
  /** Descripción normalizada: es la que agrupa, y la que propone el patrón. */
  patron: string;
  /** Una descripción real del cluster, para que se reconozca a simple vista. */
  muestra: string | null;
  facturas: number;
  monto: number;
}

export interface LineaCobertura {
  bucket: BucketCobertura;
  nombre: string;
  facturas: number;
  monto: number;
  /** Porcentaje del total facturado del mismo signo (ingreso o egreso). */
  pct: number;
  /** true cuando lo reclama un objeto derivado y no una regla de texto. */
  derivado: boolean;
}

export interface LadoCobertura {
  total: number;
  cubierto: number;
  pendiente: number;
  /** Cubierto / total, en porcentaje. null cuando no hubo nada facturado. */
  pct: number | null;
  lineas: LineaCobertura[];
}

export interface ResultadoCobertura {
  ingresos: LadoCobertura;
  egresos: LadoCobertura;
  nomina: LadoCobertura;
  /** Los clusters del residuo, de mayor a menor peso. */
  clusters: ClusterPendiente[];
  /** Cuántos clusters existen en total (los `clusters` pueden venir recortados). */
  clustersTotales: number;
  /** Reglas de la agencia que participaron en esta corrida. */
  reglasActivas: number;
}

// ─── Normalización de la descripción ─────────────────────────────────────────
// Agrupa «FILTRO DE ACEITE 90915-YZZD2» y «FILTRO DE ACEITE 04152-YZZA1» en el
// mismo cluster. Se hace en SQL —no en JS— para no traer 40 mil renglones sólo
// para agruparlos: números → «#», acentos fuera, espacios colapsados. Es la
// misma normalización que después se propone como patrón de la regla.
const SQL_NORMALIZA = Prisma.sql`
  btrim(regexp_replace(
    regexp_replace(
      translate(upper(COALESCE(d."descripcion", '')),
                'ÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛ', 'AEIOUUNAEIOUAEIOU'),
      '[0-9]+', '#', 'g'),
    '\s+', ' ', 'g'))
`;

/**
 * Trae el archivo del periodo YA AGRUPADO. Los CFDIs que reclama un objeto
 * derivado se colapsan a un renglón por bucket; el residuo se agrupa por
 * (tipo, clave dominante, descripción normalizada) — o sea, ya sale en clusters.
 *
 * El LATERAL que busca el concepto dominante se evalúa SÓLO para el residuo
 * (`ON inv.derivado IS NULL`): en un ejercicio normal la mayoría de los CFDIs
 * están derivados y no hace falta abrirles los conceptos.
 */
export async function filasCobertura(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date
): Promise<FilaCobertura[]> {
  return db.$queryRaw<FilaCobertura[]>(Prisma.sql`
    WITH inv AS (
      SELECT i.id,
             i."tipo"::text AS tipo,
             -- Nota de crédito: netea con signo negativo dentro de su tipo,
             -- igual que en el resto del motor.
             (CASE WHEN i."tipoSat" = 'E' THEN -1 ELSE 1 END) * i."subtotal"::float8 AS monto,
             CASE
               WHEN EXISTS (SELECT 1 FROM "Vehiculo" v WHERE v."ventaInvoiceId"  = i.id) THEN 'unidad_venta'
               WHEN EXISTS (SELECT 1 FROM "Vehiculo" v WHERE v."compraInvoiceId" = i.id) THEN 'unidad_compra'
               WHEN EXISTS (SELECT 1 FROM "ServicioVenta" s WHERE s."invoiceId"  = i.id) THEN 'servicio'
               WHEN EXISTS (SELECT 1 FROM "NominaCosto" n WHERE n."invoiceId"    = i.id) THEN 'nomina'
               WHEN EXISTS (SELECT 1 FROM "VehiculoCosto" c WHERE c."invoiceId"  = i.id) THEN 'unidad_costo'
               WHEN EXISTS (SELECT 1 FROM "RefaccionMovimiento" m
                            WHERE m."invoiceId" = i.id AND m."tipo" = 'ENTRADA_COMPRA')  THEN 'refaccion_compra'
               WHEN EXISTS (SELECT 1 FROM "RefaccionMovimiento" m
                            WHERE m."invoiceId" = i.id AND m."tipo" = 'SALIDA_VENTA')    THEN 'refaccion_venta'
               ELSE NULL
             END AS derivado
      FROM "Invoice" i
      WHERE i."companyId" = ${companyId}
        AND i."tipo" IN ('INGRESO', 'EGRESO', 'NOMINA')
        AND i."status" <> 'CANCELLED'
        AND i."fecha" >= ${desde} AND i."fecha" < ${hasta}
    ),
    g AS (
      SELECT COALESCE(inv.derivado, 'pendiente') AS bucket,
             inv.tipo,
             inv.monto,
             d."descripcion" AS descripcion,
             CASE WHEN inv.derivado IS NULL THEN COALESCE(d."claveProdServ", '') ELSE '' END AS clave,
             CASE WHEN inv.derivado IS NULL THEN ${SQL_NORMALIZA} ELSE '' END AS patron
      FROM inv
      LEFT JOIN LATERAL (
        SELECT ii."claveProdServ", ii."descripcion"
        FROM "InvoiceItem" ii
        WHERE ii."invoiceId" = inv.id
        ORDER BY ii."importe" DESC NULLS LAST
        LIMIT 1
      ) d ON inv.derivado IS NULL
    )
    SELECT g.bucket, g.tipo, g.clave, g.patron,
           (array_agg(g.descripcion ORDER BY abs(g.monto) DESC))[1] AS muestra,
           COUNT(*)::int                AS facturas,
           COALESCE(SUM(g.monto), 0)::float8 AS monto
    FROM g
    -- Nombres explícitos, no posiciones: agrupar por «1,2,3,4» ata el GROUP BY a
    -- la expresión proyectada y no a la columna, y ya nos costó un reporte mal
    -- agrupado una vez.
    GROUP BY g.bucket, g.tipo, g.clave, g.patron
  `);
}

/**
 * Arma el reporte. Es PURA: recibe las filas y las reglas, no toca la base —
 * así el contrato («el residuo nunca se reparte») se puede fijar en tests.
 */
export function armarCobertura(
  filas: FilaCobertura[],
  reglas: ReglaPreparada[],
  opciones: { maxClusters?: number } = {}
): ResultadoCobertura {
  const maxClusters = opciones.maxClusters ?? 50;

  const acumulado = new Map<string, LineaCobertura>();
  const clusters: ClusterPendiente[] = [];
  // Magnitud facturada por tipo, acumulada de las filas CRUDAS. No se puede
  // derivar de las líneas ya sumadas: un mes que emitió $1M y canceló $1M deja
  // la línea en cero, y medir la cobertura contra ese cero diría «no aplica»
  // cuando en realidad se facturaron $2M que sí hay que explicar.
  const magnitudPorTipo = new Map<string, number>();

  const suma = (tipo: string, bucket: BucketCobertura, facturas: number, monto: number) => {
    const k = `${tipo}|${bucket}`;
    const linea = acumulado.get(k) ?? {
      bucket,
      nombre: NOMBRE_BUCKET[bucket],
      facturas: 0,
      monto: 0,
      pct: 0,
      derivado: DERIVADOS.has(bucket),
    };
    linea.facturas += facturas;
    linea.monto = r2(linea.monto + monto);
    acumulado.set(k, linea);
  };

  for (const f of filas) {
    magnitudPorTipo.set(f.tipo, (magnitudPorTipo.get(f.tipo) ?? 0) + Math.abs(f.monto));
    if (f.bucket !== "pendiente") {
      suma(f.tipo, f.bucket as BucketCobertura, f.facturas, f.monto);
      continue;
    }

    const concepto = { tipo: f.tipo, clave: f.clave, descripcion: f.muestra ?? "" };
    const bucket = clasificarPendiente(concepto, reglas);
    suma(f.tipo, bucket, f.facturas, f.monto);
    if (bucket === "pendiente") {
      clusters.push({
        tipo: f.tipo,
        clave: f.clave,
        patron: f.patron,
        muestra: f.muestra,
        facturas: f.facturas,
        monto: r2(f.monto),
      });
    }
  }

  // Los clusters se ordenan por peso ABSOLUTO: una nota de crédito de $40M sin
  // clasificar importa tanto como un ingreso de $40M sin clasificar, y ordenar
  // por monto con signo la mandaría al final de la lista.
  clusters.sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto));

  const lado = (tipo: string): LadoCobertura => {
    const lineas = [...acumulado.entries()]
      .filter(([k]) => k.startsWith(`${tipo}|`))
      .map(([, v]) => v)
      .sort((a, b) => Math.abs(b.monto) - Math.abs(a.monto));
    const total = r2(lineas.reduce((s, l) => s + l.monto, 0));
    const pendiente = r2(lineas.filter((l) => l.bucket === "pendiente").reduce((s, l) => s + l.monto, 0));
    const cubierto = r2(total - pendiente);
    // El porcentaje se mide contra la MAGNITUD facturada, no contra el neto: si
    // el neto es ~0 porque las notas de crédito cancelan la facturación, una
    // división contra el neto reportaría coberturas absurdas (o infinitas).
    const magnitud = magnitudPorTipo.get(tipo) ?? 0;
    for (const l of lineas) l.pct = magnitud > 0 ? r2((Math.abs(l.monto) / magnitud) * 100) : 0;
    return {
      total,
      cubierto,
      pendiente,
      pct: magnitud > 0 ? r2(((magnitud - Math.abs(pendiente)) / magnitud) * 100) : null,
      lineas,
    };
  };

  return {
    ingresos: lado("INGRESO"),
    egresos: lado("EGRESO"),
    nomina: lado("NOMINA"),
    clusters: clusters.slice(0, maxClusters),
    clustersTotales: clusters.length,
    reglasActivas: reglas.length,
  };
}

/**
 * Clasifica un CFDI que ningún objeto derivado reclamó. Orden: regla de la
 * agencia, luego catálogo genérico, luego pendiente.
 */
function clasificarPendiente(
  concepto: { tipo: string; clave: string; descripcion: string },
  reglas: ReglaPreparada[]
): BucketCobertura {
  const regla = aplicarReglas(reglas, concepto);
  if (regla) {
    // Una regla de TEXTO no puede reclamar un bucket derivado: si un CFDI es
    // venta de unidad, lo decide la unidad ligada, no una frase en la
    // descripción. Una regla así se ignora y el CFDI vuelve a la cola.
    if (DERIVADOS.has(regla.destino)) return "pendiente";
    // Destino que es cuenta del catálogo COE («601.57»): es un gasto con cuenta.
    if (/^\d/.test(regla.destino)) return "gasto";
    // Destino desconocido: se trata como pendiente en vez de inventar un
    // renglón sin nombre en el reporte.
    return regla.destino in NOMBRE_BUCKET ? (regla.destino as BucketCobertura) : "pendiente";
  }

  if (concepto.tipo === "INGRESO") {
    if (concepto.clave === CLAVE_ANTICIPO) return "anticipo";
    if (concepto.clave.startsWith("8014")) {
      // clasificarIngreso devuelve «otros» cuando la descripción no empata ni
      // con bono ni con UDI. Eso NO es una clasificación: es el residuo con otro
      // nombre, y se reporta como pendiente para que salga en la cola.
      return clasificarIngreso(concepto.descripcion) === "otros" ? "pendiente" : "otros_ingresos";
    }
    return "pendiente";
  }

  if (concepto.tipo === "EGRESO") {
    // classifyEgreso SIEMPRE responde: cuando no reconoce la clave devuelve
    // «Otros gastos». Ese fallback no cuenta como cobertura — es justo el caso
    // que hay que revisar, y esconderlo en un renglón con nombre respetable es
    // como se pierde el residuo de vista.
    const { cuenta } = classifyEgreso(concepto.clave);
    return cuenta === COE_CODES.OTROS_GASTOS ? "pendiente" : "gasto";
  }

  // NOMINA sin NominaCosto: el recibo existe pero el derivador no lo procesó.
  return "pendiente";
}

/**
 * Reporte completo contra la base: carga las reglas activas de la empresa y
 * arma la cobertura del periodo.
 */
export async function calcularCobertura(
  db: PrismaClient,
  companyId: string,
  desde: Date,
  hasta: Date,
  opciones: { maxClusters?: number } = {}
): Promise<ResultadoCobertura> {
  const [filas, reglasRaw] = await Promise.all([
    filasCobertura(db, companyId, desde, hasta),
    db.reglaClasificacion.findMany({
      where: { companyId, activa: true },
      select: { id: true, ambito: true, clavePrefijo: true, patron: true, destino: true, etiqueta: true },
    }),
  ]);
  return armarCobertura(filas, prepararReglas(reglasRaw as ReglaAplicable[]), opciones);
}

export const NOTAS_COBERTURA = [
  "El residuo NO se reparte entre las líneas conocidas: se reporta tal cual. Un renglón de sobras honesto vale más que una precisión inventada.",
  "Las notas de crédito netean con signo negativo dentro de su tipo, así que una línea puede quedar en negativo si se cancelaron más facturas de las que se emitieron.",
  "El porcentaje de cobertura se mide contra el monto facturado en valor absoluto, no contra el neto: si no, un mes con muchas cancelaciones reportaría coberturas imposibles.",
  "Un CFDI se atribuye a UN bucket, el primero que lo reclama. Una factura de taller con refacciones cuenta como servicio, no dos veces.",
];
