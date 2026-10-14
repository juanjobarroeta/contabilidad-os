// ─────────────────────────────────────────────────────────────────────────────
// Lee el reporte «Existencia y Valuación» que el sistema del hospital exporta
// a Excel. PURO.
//
// Es un reporte IMPRESO volcado a celdas, no una tabla: el ancho de cada
// columna depende de lo que quepa en el renglón, así que las posiciones se
// recorren. Medido en el inventario de Haltus del 14-oct: el renglón de
// artículo aparece en las columnas [2,7,15,19,24] y también en [6,12,17,22,27],
// según el largo de la clave. Leer por índice fijo pierde una tercera parte de
// los lotes sin avisar.
//
// Por eso se lee por FORMA: se compactan las celdas no vacías y se decide por
// cuántas son y de qué tipo. Un renglón de artículo son cinco valores con tres
// números al final (existencia, costo, valor); uno de lote son de tres a cinco
// con la cantidad al final.
//
// La prueba de que la lectura está bien no es que no truene: es que la suma de
// los artículos dé el total que el propio reporte imprime.
// ─────────────────────────────────────────────────────────────────────────────

export interface LoteListado {
  lote: string;
  /** «MAR 2031» tal cual; null cuando el reporte no la imprime. */
  caducidad: string | null;
  cantidad: number | null;
  /** Rack y posición, cuando vienen. */
  ubicacion: string | null;
}

export interface ArticuloListado {
  almacen: string;
  clave: string;
  nombre: string;
  existencia: number;
  costoUnitario: number;
  valor: number;
  lotes: LoteListado[];
}

export interface InventarioListado {
  articulos: ArticuloListado[];
  /** Los subtotales que el reporte imprime, para cotejar la lectura. */
  totalImpreso: number | null;
  almacenes: string[];
}

const numero = (s: string): number | null => {
  const x = Number(String(s).replace(/[,\s]/g, ""));
  return Number.isFinite(x) ? x : null;
};

/** Celdas no vacías, en orden, sin su posición: la posición es lo que miente. */
const compactar = (r: unknown[]): string[] =>
  (r ?? []).map((x) => (x == null ? "" : String(x).trim())).filter((v) => v !== "");

/**
 * «DEC 2999» es el centinela de «no caduca» que usa el sistema del hospital:
 * 1,245 de los 2,183 lotes de Haltus lo traen. Guardarlo como fecha real
 * pondría media farmacia a caducar en el año 2999 y arruinaría cualquier
 * alerta de caducidad por rango.
 */
export const SIN_CADUCIDAD = /^\w{3}\s*2999$/i;

const MESES: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * «MAR 2031» → el ÚLTIMO día de ese mes.
 *
 * Un medicamento que caduca «marzo 2031» sirve todo marzo; ponerle el día 1
 * lo retira un mes antes de tiempo, y eso es tirar inventario bueno.
 */
export function caducidadDe(texto: string | null | undefined): Date | null {
  const s = (texto ?? "").trim().toUpperCase();
  if (!s || SIN_CADUCIDAD.test(s)) return null;
  const m = /^([A-Z]{3})\s*(\d{4})$/.exec(s);
  if (!m || !(m[1] in MESES)) return null;
  const anio = Number(m[2]);
  if (anio < 1990 || anio > 2100) return null;
  return new Date(Date.UTC(anio, MESES[m[1]] + 1, 0));
}

/** ¿Este renglón abre un almacén? */
const esAlmacen = (c: string[]): boolean => c.length === 1 && /^ALMACEN\s+/i.test(c[0]);

/** Un subtotal trae cuatro valores y el último es un porcentaje. */
const esSubtotal = (c: string[]): boolean => c.length === 4 && /%\s*$/.test(c[3]);

/**
 * Artículo: clave, nombre y tres números (existencia, costo, valor).
 * La clave nunca es sólo dígitos — eso delata un renglón de cifras sueltas.
 */
function comoArticulo(c: string[]): Omit<ArticuloListado, "almacen" | "lotes"> | null {
  if (c.length !== 5) return null;
  if (/^\d+$/.test(c[0]) || /%\s*$/.test(c[4])) return null;
  const [existencia, costoUnitario, valor] = [numero(c[2]), numero(c[3]), numero(c[4])];
  if (existencia == null || costoUnitario == null || valor == null) return null;
  if (!c[0] || !c[1]) return null;
  return { clave: c[0], nombre: c[1], existencia, costoUnitario, valor };
}

/**
 * Lote: termina en la cantidad y trae el número de lote antes de la caducidad.
 * Las formas vistas van de tres a seis valores según cuánta ubicación imprima.
 */
function comoLote(c: string[]): LoteListado | null {
  if (c.length < 3 || c.length > 6) return null;
  const cantidad = numero(c[c.length - 1]);
  if (cantidad == null) return null;
  // De atrás para adelante: cantidad, caducidad, lote. La ubicación es lo que sobre.
  const posibleCaducidad = c[c.length - 2] ?? "";
  const tieneCaducidad = /^[A-Z]{3}\s*\d{4}$/i.test(posibleCaducidad);
  const lote = tieneCaducidad ? c[c.length - 3] : c[c.length - 2];
  // Un lote PUEDE ser todo dígitos: «14937528», «210469». Rechazarlos por
  // numéricos tiraba los lotes reales y dejaba el artículo sin trazabilidad.
  if (!lote) return null;
  const ubicacion = c.slice(0, c.length - (tieneCaducidad ? 3 : 2)).join("-") || null;
  return { lote, caducidad: tieneCaducidad ? posibleCaducidad : null, cantidad, ubicacion };
}

export function parseInventario(filas: unknown[][]): InventarioListado {
  const articulos: ArticuloListado[] = [];
  const almacenes: string[] = [];
  let almacen = "GENERAL";
  let actual: ArticuloListado | null = null;
  let subtotales = 0;

  for (const r of filas) {
    const c = compactar(r);
    if (!c.length) continue;

    if (esAlmacen(c)) {
      almacen = c[0].replace(/\s+/g, " ").trim();
      if (!almacenes.includes(almacen)) almacenes.push(almacen);
      actual = null;
      continue;
    }
    if (esSubtotal(c)) {
      subtotales += numero(c[2]) ?? 0;
      actual = null;
      continue;
    }

    const art = comoArticulo(c);
    if (art) {
      actual = { almacen, ...art, lotes: [] };
      articulos.push(actual);
      continue;
    }

    const lote = comoLote(c);
    if (lote && actual) actual.lotes.push(lote);
  }

  // El reporte imprime un subtotal por almacén Y un gran total con la misma
  // forma, así que la suma de todos vale exactamente el doble del inventario.
  const totalImpreso = subtotales > 0 ? Math.round((subtotales / 2) * 100) / 100 : null;
  return { articulos, totalImpreso, almacenes };
}

/** La suma de los artículos leídos, para cotejarla contra `totalImpreso`. */
export function valorLeido(articulos: ArticuloListado[]): number {
  return Math.round(articulos.reduce((s, a) => s + a.valor, 0) * 100) / 100;
}

/**
 * La categoría que el prefijo de la clave implica.
 *
 * El hospital ya clasificó su catálogo al numerarlo —MAT de material, MED de
 * medicamento, SOL de solución— y ese prefijo es más confiable que adivinar
 * por el nombre. Lo que no se reconoce cae en OTRO a propósito: dejar todo en
 * MEDICAMENTO (el default del modelo) marcaría la papelería y los artículos de
 * limpieza como medicina, y de ahí salen los controles sanitarios.
 */
export function categoriaDeClave(clave: string): "MEDICAMENTO" | "MATERIAL_CURACION" | "SOLUCION" | "EQUIPO" | "REACTIVO" | "OTRO" {
  const p = (/^[A-Z]+/i.exec(clave.trim().toUpperCase())?.[0] ?? "").toUpperCase();
  if (p === "MED" || p === "MDC") return "MEDICAMENTO";
  if (p === "MAT" || p === "MSI" || p === "CEYE" || p === "MCF") return "MATERIAL_CURACION";
  if (p === "SOL") return "SOLUCION";
  if (p === "REAC" || p === "LAB") return "REACTIVO";
  if (p === "EQ" || p === "EQUIPO" || p === "MTTO") return "EQUIPO";
  return "OTRO";
}
