// Tratamiento de IVA esperado según la clave de producto/servicio del SAT
// (c_ClaveProdServ, el mismo catálogo que sirve Facturapi en
// /api/sat/catalogs/products).
//
// Propósito: cuando el emisor selecciona una clave que corresponde con alta
// confianza a una categoría de TASA CERO (Art. 2o.-A LIVA) pero elige IVA 16%
// o Exento en el formulario, mostramos una pista NO BLOQUEANTE ("suele ser
// IVA 0% — verifícalo con tu contador"). Nunca cambiamos la selección del
// usuario ni impedimos continuar: la clasificación fiscal es responsabilidad
// del contribuyente y su contador; aquí solo prevenimos el error más común
// (el caso real: una emisora de agua facturó sin tasa 0 ni exención).
//
// Política de curación — CONSERVADORA, solo prefijos verificados:
//   - Cada prefijo se verificó contra el catálogo oficial c_ClaveProdServ del
//     SAT (filas vigentes, sin fecha de fin de vigencia) revisando TODAS las
//     claves que cubre, para confirmar que ninguna cae en una excepción del
//     Art. 2o.-A LIVA (bebidas distintas de la leche, jarabes o concentrados,
//     suplementos alimenticios, etc.).
//   - Categorías con excepciones frecuentes que la clave no permite
//     distinguir (bebidas saborizadas, jugos, refrescos, alimentos
//     preparados, pan y galletas) se dejan FUERA a propósito.
//   - Tortillas y masa de nixtamal NO tienen clave propia en el catálogo
//     (la única coincidencia es un utensilio de cocina, 52151909), por lo que
//     esa categoría no se pudo curar.
//   - Para cualquier clave no curada la función regresa null: sin opinión.

export interface IvaEsperado {
  /** Tratamiento esperado; hoy solo curamos categorías de tasa cero ("0"). */
  tratamiento: "0" | "16";
  /** Nombre corto de la categoría, para el texto de la pista. */
  etiqueta: string;
  /** Fundamento legal citado en la pista. */
  fundamento: string;
}

interface ReglaTasaCero {
  /** La clave aplica si inicia con alguno de estos prefijos... */
  prefijos: string[];
  /** ...salvo que inicie con alguno de estos (subcategorías excluidas). */
  exclusiones?: string[];
  etiqueta: string;
  fundamento: string;
}

const FUNDAMENTO_ALIMENTOS =
  "Art. 2o.-A, fracc. I, inciso b) LIVA (productos destinados a la alimentación)";

// Verificación: catálogo c_ClaveProdServ del SAT vigente (revisado 2026-07).
const REGLAS_TASA_CERO: ReglaTasaCero[] = [
  {
    // 50202301 "Agua" — clave exacta. El resto de la clase 502023 (Bebidas no
    // alcohólicas) son refrescos, jugos, bebidas deportivas y agua mineral
    // (50202310, gaseosa), todos gravados al 16%, por eso NO se usa la clase
    // completa como prefijo.
    prefijos: ["50202301"],
    etiqueta: "agua natural o purificada, no saborizada",
    fundamento:
      "Art. 2o.-A, fracc. I, inciso c) LIVA — agua no gaseosa ni compuesta; en presentaciones menores a 10 litros aplica 16%",
  },
  {
    // 50202302 "Hielo" — mismo inciso que el agua, sin la condición de envase.
    prefijos: ["50202302"],
    etiqueta: "hielo",
    fundamento: "Art. 2o.-A, fracc. I, inciso c) LIVA",
  },
  {
    // Clase 501317 "Productos de leche y mantequilla" (50131700–50131704:
    // frescos, de estante, congelados, leche en polvo). Se excluyen
    // 50131705 "Proteína de suero de leche" (suplemento alimenticio, gravado
    // al 16% conforme al criterio normativo del SAT) y 50131706 "Lactosa"
    // (insumo industrial, fuera del alcance conservador).
    prefijos: ["501317"],
    exclusiones: ["50131705", "50131706"],
    etiqueta: "leche y productos lácteos básicos",
    fundamento: FUNDAMENTO_ALIMENTOS,
  },
  {
    // Clase 501316 "Huevos y sustitutos" — las 26 claves vigentes son huevo
    // en cáscara, cocido, deshidratado y derivados: todos alimentos.
    prefijos: ["501316"],
    etiqueta: "huevo",
    fundamento: FUNDAMENTO_ALIMENTOS,
  },
  {
    // Familias 5030 (fruta fresca) y 5031 (fruta fresca orgánica). Se excluye
    // la clase 503075 "Subproductos de frutas frescas": contiene 50307502
    // "Extracto de naranja para mezclar en agua", un concentrado para
    // bebidas gravado al 16% (Art. 2o.-A, fracc. I, inciso b), numeral 2).
    prefijos: ["5030", "5031"],
    exclusiones: ["503075"],
    etiqueta: "fruta fresca sin procesar",
    fundamento: FUNDAMENTO_ALIMENTOS,
  },
  {
    // Familias 5040 (verduras frescas) y 5041 (verduras frescas orgánicas).
    // Se revisaron las 56 clases de 5040: todas son hortalizas, hierbas y
    // vegetales frescos, sin subproductos ni preparados.
    prefijos: ["5040", "5041"],
    etiqueta: "verdura fresca sin procesar",
    fundamento: FUNDAMENTO_ALIMENTOS,
  },
  {
    // Segmento 51 "Medicamentos y productos farmacéuticos" — las familias
    // vigentes (5110–5125) son todas clases farmacológicas (antibióticos,
    // antidiabéticos, inmunodepresores, etc.). Se excluyen la clase 511919
    // "Suplementos dietéticos y productos de terapia alimenticia" y la clave
    // 51191805 "Suplemento de potasio": los suplementos alimenticios NO son
    // medicinas de patente y se gravan al 16%.
    prefijos: ["51"],
    exclusiones: ["511919", "51191805"],
    etiqueta: "medicinas de patente",
    fundamento: "Art. 2o.-A, fracc. I, inciso b) LIVA (medicinas de patente)",
  },
];

/**
 * Tratamiento de IVA esperado para una clave de producto/servicio del SAT.
 *
 * Regresa null para la gran mayoría de las claves: solo opina cuando la clave
 * cae en una categoría curada de tasa cero de alta confianza. El resultado es
 * una PISTA, nunca una determinación fiscal.
 */
export function ivaEsperadoPorClave(productKey: string): IvaEsperado | null {
  const clave = (productKey ?? "").trim();
  // Las claves del catálogo son exactamente 8 dígitos; cualquier otra cosa
  // (vacío, texto libre, clave a medio escribir) queda sin opinión.
  if (!/^\d{8}$/.test(clave)) return null;

  for (const regla of REGLAS_TASA_CERO) {
    if (regla.exclusiones?.some((p) => clave.startsWith(p))) continue;
    if (regla.prefijos.some((p) => clave.startsWith(p))) {
      return {
        tratamiento: "0",
        etiqueta: regla.etiqueta,
        fundamento: regla.fundamento,
      };
    }
  }
  return null;
}

/**
 * Detecta la contradicción entre el tratamiento esperado por la clave y la
 * selección del usuario en el formulario. Regresa el tratamiento esperado
 * cuando difieren (para mostrar la pista) y null cuando coinciden o cuando la
 * clave no está curada.
 */
export function contradiccionIva(
  productKey: string,
  ivaSeleccionado: "16" | "0" | "EXENTO"
): IvaEsperado | null {
  const esperado = ivaEsperadoPorClave(productKey);
  if (!esperado) return null;
  return esperado.tratamiento === ivaSeleccionado ? null : esperado;
}
