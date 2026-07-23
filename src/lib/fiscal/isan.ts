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
  /** true sólo cuando los montos fueron cotejados contra DOF / Anexo 15 RMF. */
  verificada: boolean;
  fuente: string;
};

// Montos tomados del Anexo 15 de la RMF (actualización anual por INPC).
// ⚠️ `verificada: false`: cotejar contra el DOF del ejercicio antes de activar
// el timbrado de ventas con ISAN en producción. Actualizar vía PR (mismo
// mecanismo que el INPC).
const TARIFAS: Record<number, IsanTarifa> = {
  2026: {
    ejercicio: 2026,
    brackets: [
      { limiteInferior: 0.01, limiteSuperior: 381_983.75, cuotaFija: 0, tasaExcedente: 0.02 },
      { limiteInferior: 381_983.76, limiteSuperior: 458_380.35, cuotaFija: 7_639.66, tasaExcedente: 0.05 },
      { limiteInferior: 458_380.36, limiteSuperior: 534_777.11, cuotaFija: 11_459.5, tasaExcedente: 0.1 },
      { limiteInferior: 534_777.12, limiteSuperior: 687_570.42, cuotaFija: 19_099.17, tasaExcedente: 0.15 },
      { limiteInferior: 687_570.43, limiteSuperior: null, cuotaFija: 42_018.16, tasaExcedente: 0.17 },
    ],
    exencionTotalHasta: 317_519.71,
    exencionParcialHasta: 402_258.29,
    verificada: false,
    fuente:
      "PENDIENTE de cotejo — Anexo 15 RMF (tarifa Art. 3-I y montos Art. 8-II actualizados por INPC). No timbrar ISAN en producción hasta verificar.",
  },
};

export function getTarifaIsan(ejercicio: number): IsanTarifa | null {
  return TARIFAS[ejercicio] ?? null;
}

export type IsanResultado = {
  /** Base gravable: precio de enajenación sin IVA (Art. 2). */
  base: number;
  /** Impuesto según tarifa Art. 3-I, antes de exenciones. */
  impuestoTarifa: number;
  /** "TOTAL" (no paga), "PARCIAL" (paga 50%), o null (paga completo). */
  exencion: "TOTAL" | "PARCIAL" | null;
  /** Impuesto a cargo después de aplicar Art. 8-II. */
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
    return { base: 0, impuestoTarifa: 0, exencion: null, isan: 0, advertencias };
  }

  if (!tarifa) {
    advertencias.push(
      `Sin tarifa ISAN cargada para el ejercicio ${ejercicio} — capturar en src/lib/fiscal/isan.ts (Anexo 15 RMF). ISAN calculado como $0.`
    );
    return { base: precioSinIva, impuestoTarifa: 0, exencion: null, isan: 0, advertencias };
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

  let exencion: IsanResultado["exencion"] = null;
  let isan = impuestoTarifa;
  if (precioSinIva <= tarifa.exencionTotalHasta) {
    exencion = "TOTAL";
    isan = 0;
  } else if (precioSinIva <= tarifa.exencionParcialHasta) {
    exencion = "PARCIAL";
    isan = impuestoTarifa * 0.5;
  }

  return {
    base: precioSinIva,
    impuestoTarifa: round2(impuestoTarifa),
    exencion,
    isan: round2(isan),
    advertencias,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
