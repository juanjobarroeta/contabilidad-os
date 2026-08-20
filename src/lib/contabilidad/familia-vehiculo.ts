// ─────────────────────────────────────────────────────────────────────────────
// Familia comercial de una unidad, desde sus generales (marca/modelo/versión).
//
// El plan de cuentas del contador subdivide ventas/costo/inventario de unidades
// POR FAMILIA con el mismo sufijo en las tres series: FRISON es 4101-0004
// (venta), 5101-0004 (costo) y 1301-0004 (inventario). Este módulo es el mapa
// modelo→familia que hace posible resolver a esa subcuenta exacta (Fase 2 de
// docs/PLAN-motor-plan-propio.md).
//
// El mapa nació en scripts/divergencia-ce-margom.ts, donde se validó familia
// por familia contra la balanza presentada (CeBalanzaMes). Aquí vive la copia
// canónica; el script importa de aquí.
//
// Los patrones están en sintaxis de REGEX DE POSTGRES (\m / \M como fronteras
// de palabra) porque el script los sigue usando en SQL (`t ~ patrón`). Para
// usarlos en JS, `regexJs()` traduce esas fronteras a \b. Un solo origen, dos
// dialectos — mantener los dos a mano divergiría.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * familia → (sufijo de subcuenta, regex sobre `modelo versión marca` en
 * MAYÚSCULAS). El ORDEN importa (primer match gana). «PASS|PASAJEROS»: los 454
 * SUNRAY PASAJEROS CBU de la mega-compra de dic-2024 van a PASS (0013) —
 * mapearlos a CARGO desbalanceó ambos lados por $263.8M en el primer intento.
 */
export const FAMILIAS: readonly (readonly [string, string, string])[] = [
  ["TRAVELER", "0028", "TRAVELER"],
  ["E10X", "0001", "E ?10X"],
  ["E30X", "0002", "E ?30X"],
  ["EJ7", "0003", "EJ ?7"],
  ["X12000", "0022", "X ?12000"],
  ["EX650", "0024", "EX ?650"],
  ["EX450", "0027", "EX ?450"],
  ["X350", "0016", "X ?350"],
  ["X250", "0015", "X ?250"],
  ["X200", "0014", "X ?200"],
  ["FRISON", "0004", "FRIS"],
  ["TRACTO K7", "0025", "K7"],
  ["SUNRAY PASS", "0013", "SUNRAY.*(PASS|PASAJEROS)|(PASS|PASAJEROS).*SUNRAY"],
  ["SUNRAY CHASIS", "0026", "SUNRAY.*CHASIS|CHASIS.*SUNRAY"],
  ["E SUNRAY", "0017", "\\mE[ -]?SUNRAY"],
  ["SUNRAY CARGO", "0018", "SUNRAY"],
  ["JAC6", "0021", "JAC ?6"],
  ["JAC8", "0023", "JAC ?8"],
  ["JAC2", "0019", "JAC ?2\\M"],
  ["JAC4", "0020", "JAC ?4\\M"],
  ["SEI2", "0008", "JS ?2|SEI ?2"],
  ["SEI3", "0009", "JS ?3|SEI ?3"],
  ["SEI4", "0010", "JS ?4|SEI ?4"],
  ["SEI6", "0011", "JS ?6|SEI ?6"],
  ["SEI7", "0012", "SEI ?7"],
  ["SEI1", "0007", "SEI ?1\\M"],
  ["J7", "0006", "\\mJ7\\M"],
  ["J4", "0005", "\\mJ4\\M"],
];

/** Traduce un patrón (dialecto Postgres) a RegExp de JS: \m y \M → \b. */
export function regexJs(patron: string): RegExp {
  return new RegExp(patron.replace(/\\m|\\M/g, "\\b"));
}

// Compilados una vez al cargar el módulo (el orden del arreglo se preserva).
const COMPILADAS: readonly (readonly [string, RegExp])[] = FAMILIAS.map(
  ([, sufijo, patron]) => [sufijo, regexJs(patron)] as const,
);

export interface GeneralesUnidad {
  marca: string | null;
  modelo: string | null;
  version: string | null;
}

/**
 * Sufijo de familia ("0004") para una unidad, o null si ninguna familia
 * matchea. Mismo texto y mismo orden que el SQL del script de divergencia:
 * UPPER(modelo ⧺ versión ⧺ marca), primer match gana.
 */
export function familiaDeUnidad(u: GeneralesUnidad): string | null {
  const t = `${u.modelo ?? ""} ${u.version ?? ""} ${u.marca ?? ""}`.toUpperCase();
  for (const [sufijo, re] of COMPILADAS) {
    if (re.test(t)) return sufijo;
  }
  return null;
}

export interface UnidadAmparada extends GeneralesUnidad {
  /** id del Invoice que la ampara (compra o venta, según el lado). */
  invoiceId: string;
  vin: string;
  costoCompra: number;
  /** Precio de la venta; sirve para reconocer el intercambio (ver intercambio.ts). */
  precioVenta?: number | null;
}

export interface UnidadResuelta {
  sufijo: string;
  vin: string;
  /** Suma de costoCompra de las unidades del CFDI (normalmente una). */
  costo: number;
  /** Suma de precioVenta; 0 si el CFDI no es de venta o no está costeada. */
  precio: number;
}

/**
 * Agrupa unidades por su invoice y resuelve la familia. Conservador a
 * propósito: un CFDI cuyas unidades no mapean a UNA sola familia (mixto, o
 * alguna sin familia) se descarta y postea por el flujo de siempre. En MARGOM
 * hoy la relación es 1:1 (10,698 ventas : 10,698 unidades, cero multi-unidad),
 * pero el dato no es una garantía del esquema.
 */
export function agruparUnidadesAmparadas(unidades: UnidadAmparada[]): Map<string, UnidadResuelta> {
  const porInvoice = new Map<string, UnidadAmparada[]>();
  for (const u of unidades) {
    const lista = porInvoice.get(u.invoiceId) ?? [];
    lista.push(u);
    porInvoice.set(u.invoiceId, lista);
  }

  const out = new Map<string, UnidadResuelta>();
  for (const [invoiceId, lista] of porInvoice) {
    const sufijos = lista.map(familiaDeUnidad);
    const sufijo = sufijos[0];
    if (!sufijo || sufijos.some((s) => s !== sufijo)) continue;
    out.set(invoiceId, {
      sufijo,
      vin: lista[0].vin,
      costo: lista.reduce((s, u) => s + (u.costoCompra || 0), 0),
      precio: lista.reduce((s, u) => s + (u.precioVenta || 0), 0),
    });
  }
  return out;
}
