// ─────────────────────────────────────────────────────────────────────────────
// ISAN — Impuesto Sobre Automóviles Nuevos (Ley Federal del ISAN).
//
// Lo causa el distribuidor autorizado al enajenar automóviles NUEVOS (Art. 1);
// la base es el precio de enajenación incluido el equipo opcional, común o de
// lujo, SIN disminuir descuentos, rebajas o bonificaciones y sin incluir IVA
// (Art. 2). El impuesto se determina con la tarifa progresiva del Art. 3-I
// (cuota fija + % sobre el excedente del límite inferior).
//
// Art. 8-II: exención total para unidades cuyo precio no excede el umbral
// inferior, y del 50% del impuesto para precios entre el umbral inferior y el
// superior. Los montos de la tarifa y de los umbrales se actualizan cada
// ejercicio por INPC (Art. 3 último párrafo) y se publican en el DOF / Anexo 15
// de la RMF — versionados aquí por ejercicio, `verificada: false` hasta cotejar
// contra la fuente oficial, igual que el patrón de `inpc.ts`.
//
// Fuera de alcance (por ahora): Art. 3-II (camiones con capacidad de carga
// hasta 4,250 kg tributan al 5% sobre el precio), importación definitiva por
// no-distribuidores, y la distribución estatal del impuesto (la recaudación la
// administran las entidades federativas — es transparente para el cálculo).
// ─────────────────────────────────────────────────────────────────────────────

export type IsanBracket = {
  limiteInferior: number;
  limiteSuperior: number | null; // null = en adelante
  cuotaFija: number;
  tasaExcedente: number; // 0.02 = 2%
};

export type IsanTarifa = {
  ejercicio: number;
  /** Tarifa Art. 3-I (progresiva sobre el precio sin IVA). */
  brackets: IsanBracket[];
  /** Art. 8-II: precio ≤ este monto → exención total. */
  exencionTotalHasta: number;
  /** Art. 8-II: precio ≤ este monto (y > exencionTotalHasta) → exención del 50%. */
  exencionParcialHasta: number;
  /**
   * Reducción para autos de gama alta (Art. 8, último párrafo, reflejado en la
   * nota al pie de la tarifa del Anexo 15): si el precio excede este umbral, se
   * REDUCE del impuesto determinado el `reduccionLujoTasa` sobre el excedente.
   * `null` si el ejercicio no contempla la reducción.
   */
  reduccionLujoDesde: number | null;
  reduccionLujoTasa: number; // 0.07 = 7%
  /** true sólo cuando los montos fueron cotejados contra DOF / Anexo 15 RMF. */
  verificada: boolean;
  fuente: string;
};

// Montos tomados del Anexo 15 de la RMF (actualización anual por INPC).
const TARIFAS: Record<number, IsanTarifa> = {
  2026: {
    ejercicio: 2026,
    // Anexo 15-A RMF 2026 (DOF 28-dic-2025). Tarifa Art. 3-I.
    brackets: [
      { limiteInferior: 0.01, limiteSuperior: 383_940.35, cuotaFija: 0, tasaExcedente: 0.02 },
      { limiteInferior: 383_940.36, limiteSuperior: 460_728.35, cuotaFija: 7_678.67, tasaExcedente: 0.05 },
      { limiteInferior: 460_728.36, limiteSuperior: 537_516.64, cuotaFija: 11_518.25, tasaExcedente: 0.1 },
      { limiteInferior: 537_516.65, limiteSuperior: 691_092.34, cuotaFija: 19_197.04, tasaExcedente: 0.15 },
      { limiteInferior: 691_092.35, limiteSuperior: null, cuotaFija: 42_233.35, tasaExcedente: 0.17 },
    ],
    // Anexo 15-B RMF 2026: Art. 8o. fracción II.
    exencionTotalHasta: 356_934.05, // primer párrafo
    exencionParcialHasta: 452_116.48, // segundo párrafo (hasta)
    // Nota al pie de la tarifa 15-A: reducción del 7% sobre el excedente de
    // $1,060,189.93 para el ejercicio 2026.
    reduccionLujoDesde: 1_060_189.93,
    reduccionLujoTasa: 0.07,
    verificada: true,
    fuente: "Anexo 15 RMF 2026, publicado en el DOF el 28-dic-2025 (rubros A y B).",
  },
};

export function getTarifaIsan(ejercicio: number): IsanTarifa | null {
  return TARIFAS[ejercicio] ?? null;
}

export type IsanResultado = {
  /** Base gravable: precio de enajenación sin IVA (Art. 2). */
  base: number;
  /** Impuesto según tarifa Art. 3-I, antes de exenciones y reducción. */
  impuestoTarifa: number;
  /** Reducción por gama alta aplicada (7% del excedente); 0 si no aplica. */
  reduccionLujo: number;
  /** "TOTAL" (no paga), "PARCIAL" (paga 50%), o null (paga completo). */
  exencion: "TOTAL" | "PARCIAL" | null;
  /** Impuesto a cargo después de aplicar Art. 8-II y la reducción. */
  isan: number;
  /** Advertencias operativas (tarifa no verificada, ejercicio sin tabla…). */
  advertencias: string[];
};

/**
 * Calcula el ISAN de una unidad NUEVA con la tarifa del ejercicio dado.
 *
 * `precioSinIva` debe venir SIN disminuir descuentos/rebajas/bonificaciones
 * (Art. 2) — es responsabilidad del caller pasar el precio de enajenación
 * bruto, no el neto negociado.
 *
 * Si no hay tarifa cargada para el ejercicio devuelve isan=0 con advertencia:
 * preferimos un cálculo explícitamente incompleto (visible en la UI) a
 * inventar un impuesto con la tarifa de otro año.
 */
export function calcularIsan(
  precioSinIva: number,
  ejercicio: number,
  tarifa: IsanTarifa | null = getTarifaIsan(ejercicio)
): IsanResultado {
  const advertencias: string[] = [];

  if (!(precioSinIva > 0)) {
    return { base: 0, impuestoTarifa: 0, reduccionLujo: 0, exencion: null, isan: 0, advertencias };
  }

  if (!tarifa) {
    advertencias.push(
      `Sin tarifa ISAN cargada para el ejercicio ${ejercicio} — capturar en src/lib/fiscal/isan.ts (Anexo 15 RMF). ISAN calculado como $0.`
    );
    return { base: precioSinIva, impuestoTarifa: 0, reduccionLujo: 0, exencion: null, isan: 0, advertencias };
  }

  if (!tarifa.verificada) {
    advertencias.push(
      `Tarifa ISAN ${tarifa.ejercicio} NO verificada contra DOF/Anexo 15 — cotejar antes de timbrar. (${tarifa.fuente})`
    );
  }

  const bracket =
    tarifa.brackets.find(
      (b) =>
        precioSinIva >= b.limiteInferior &&
        (b.limiteSuperior === null || precioSinIva <= b.limiteSuperior)
    ) ?? tarifa.brackets[tarifa.brackets.length - 1];

  const impuestoTarifa =
    bracket.cuotaFija + (precioSinIva - bracket.limiteInferior) * bracket.tasaExcedente;

  // Reducción de gama alta (Anexo 15-A, nota al pie): reduce el impuesto en el
  // 7% del excedente sobre el umbral. No lleva el impuesto por debajo de cero.
  let reduccionLujo = 0;
  if (tarifa.reduccionLujoDesde != null && precioSinIva > tarifa.reduccionLujoDesde) {
    reduccionLujo = Math.min(
      impuestoTarifa,
      (precioSinIva - tarifa.reduccionLujoDesde) * tarifa.reduccionLujoTasa
    );
  }
  const impuestoTrasReduccion = impuestoTarifa - reduccionLujo;

  // Exención Art. 8-II y reducción de gama alta son mutuamente excluyentes por
  // construcción (los umbrales no se solapan), pero el orden es explícito: la
  // exención opera sobre el impuesto ya reducido.
  let exencion: IsanResultado["exencion"] = null;
  let isan = impuestoTrasReduccion;
  if (precioSinIva <= tarifa.exencionTotalHasta) {
    exencion = "TOTAL";
    isan = 0;
  } else if (precioSinIva <= tarifa.exencionParcialHasta) {
    exencion = "PARCIAL";
    isan = impuestoTrasReduccion * 0.5;
  }

  return {
    base: precioSinIva,
    impuestoTarifa: round2(impuestoTarifa),
    reduccionLujo: round2(reduccionLujo),
    exencion,
    isan: round2(isan),
    advertencias,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
