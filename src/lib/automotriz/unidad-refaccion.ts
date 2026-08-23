// ─────────────────────────────────────────────────────────────────────────────
// Costo de una refacción EN LA UNIDAD EN QUE SE VENDE.
//
// El problema, con números reales de MARGOM: un lubricante se COMPRA por tambo
// (208 L) y se VENDE por litro. `Refaccion.ultimoCosto` guarda el costo del
// TAMBO, así que multiplicarlo por los litros que salen del kardex infla el
// costo unas 200 veces — $3.5M de venta se volvían $85M de costo y la absorción
// de servicio caía a −768%.
//
// Hasta ahora se resolvía DESCARTANDO esas piezas del cálculo. Eso evita la
// cifra absurda pero deja fuera venta real de los dos lados del cociente, así
// que la absorción sale más baja de lo que es y nadie sabe por qué.
//
// La salida es guardar el FACTOR —cuántas unidades de venta trae una unidad de
// compra— y dividir. Se guarda el factor y no el costo ya normalizado porque el
// factor es un hecho del producto (un tambo trae 208 litros) y no cambia con
// cada compra; el costo sí.
//
// Buena parte de los factores está escrita en el propio catálogo: «208LT
// (TAMBO)», «TAMBOR 208 LTS.», «CUBETA 19 LTS», «/200L» en el número de parte.
// Lo que no se pueda leer con seguridad se queda en null y lo pone una persona:
// un factor equivocado es PEOR que ninguno, porque convierte un costo absurdo
// —que se nota— en uno plausible pero falso, que no.
// ─────────────────────────────────────────────────────────────────────────────

/** Claves del SAT que significan «litro». */
const CLAVES_LITRO = new Set(["LTR", "LT", "L"]);
/** Claves del SAT que significan «kilogramo». */
const CLAVES_KILO = new Set(["KGM", "KG"]);

export interface FactorDetectado {
  /** Cuántas unidades de VENTA trae una unidad de COMPRA. */
  factor: number;
  /** Qué parte del texto lo sostiene, para poder auditarlo. */
  evidencia: string;
}

/**
 * Lee el tamaño del empaque desde la descripción y/o el número de parte.
 *
 * `unidadVenta` es la clave del SAT en que se vende. Sólo se devuelve factor
 * cuando el tamaño leído está EN ESA MISMA unidad: leer «208 L» no sirve de
 * nada si la pieza se vende por kilo, y aplicarlo sería inventar.
 */
export function factorDesdeTexto(
  descripcion: string | null | undefined,
  numeroParte: string | null | undefined,
  unidadVenta: string | null | undefined
): FactorDetectado | null {
  const texto = `${descripcion ?? ""} ${numeroParte ?? ""}`.toUpperCase();
  if (!texto.trim() || !unidadVenta) return null;
  const venta = unidadVenta.toUpperCase().trim();

  const enLitros = CLAVES_LITRO.has(venta);
  const enKilos = CLAVES_KILO.has(venta);
  if (!enLitros && !enKilos) return null;

  // Se prueban en orden de CERTEZA, no de frecuencia: primero lo que nombra el
  // envase («TAMBOR 208 LTS»), luego la cifra suelta con unidad.
  const patrones: Array<{ re: RegExp; escala?: number; soloLitros?: boolean }> = enLitros
    ? [
        // «TAMBOR 208 LTS.», «TAMBO 200 L», «CUBETA 19 LTS»
        { re: /(?:TAMBOR?|CUBETA|GARRAFA|PORRON)\s*(?:DE\s*)?(\d+(?:[.,]\d+)?)\s*L(?:TS?)?\b/ },
        // «208LT (TAMBO)» — la cifra primero y el envase después
        { re: /(\d+(?:[.,]\d+)?)\s*L(?:TS?)?\b[^A-Z0-9]{0,4}\(?\s*(?:TAMBOR?|CUBETA)/ },
        // «T/200» — tambo de 200, notación del proveedor
        { re: /\bT\/(\d+(?:[.,]\d+)?)\b/ },
        // «/200L» o «/200LX1» dentro del número de parte
        { re: /\/(\d+(?:[.,]\d+)?)\s*L(?:TS?)?(?:X\d+)?\b/ },
        // «.946LT», «5L», «19 LTS» sueltos
        { re: /(\d+(?:[.,]\d+)?)\s*L(?:TS?)?\b/ },
        // «1000ML» → mililitros
        { re: /(\d+(?:[.,]\d+)?)\s*ML\b/, escala: 1 / 1000 },
      ]
    : [
        { re: /(?:CUBETA|TAMBOR?)\s*(?:DE\s*)?(\d+(?:[.,]\d+)?)\s*KGS?\b/ },
        { re: /(\d+(?:[.,]\d+)?)\s*KGS?\b[^A-Z0-9]{0,4}\(?\s*(?:CUBETA|TAMBOR?)/ },
        { re: /(\d+(?:[.,]\d+)?)\s*KGS?\b/ },
      ];

  for (const { re, escala = 1 } of patrones) {
    const m = texto.match(re);
    if (!m) continue;
    const n = Number(m[1].replace(",", ".")) * escala;
    // Un factor de 1 no normaliza nada y uno absurdo delata una lectura mala:
    // no existe un envase de 5,000 litros en un almacén de refacciones.
    if (!Number.isFinite(n) || n <= 1 || n > 1000) continue;
    return { factor: redondear(n), evidencia: m[0].trim() };
  }
  return null;
}

/**
 * Costo de una unidad de VENTA. Devuelve null cuando no se puede afirmar —que
 * es distinto de cero— para que quien llame decida si excluye la pieza o pide
 * el factor.
 */
export function costoEnUnidadDeVenta(r: {
  ultimoCosto: number;
  ultimoPrecio?: number | null;
  unidadCosto?: string | null;
  unidadPrecio?: string | null;
  factorCosto?: number | null;
}): number | null {
  if (!(r.ultimoCosto > 0)) return null;

  const mismasUnidades =
    r.unidadCosto == null || r.unidadPrecio == null || r.unidadCosto === r.unidadPrecio;

  // Con factor guardado manda el factor, incluso si las unidades se ven
  // iguales: hay filas donde la clave del SAT es la misma («H87», pieza) para
  // el tambo y para el litro, y ahí la clave no distingue nada.
  if (r.factorCosto != null && r.factorCosto > 0) {
    return redondear(r.ultimoCosto / r.factorCosto);
  }

  if (!mismasUnidades) return null;

  // Sin factor y con unidades iguales, queda la prueba de sensatez: en una
  // refacción, un costo mayor al doble del precio no ocurre por negocio.
  if ((r.ultimoPrecio ?? 0) > 0 && r.ultimoCosto > (r.ultimoPrecio ?? 0) * 2) return null;

  return r.ultimoCosto;
}

const redondear = (n: number) => Math.round(n * 10000) / 10000;
