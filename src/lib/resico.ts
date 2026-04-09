// ─────────────────────────────────────────────────────────────────────────────
// RESICO — Régimen Simplificado de Confianza
//
// PF (Personas Físicas, régimen 626): Art. 113-E LISR
//   ISR = tarifa progresiva mensual sobre ingresos efectivamente cobrados
//   (no sobre utilidad — no hay coeficiente ni deducciones).
//
//   Tarifa mensual vigente 2024-2026 (SAT):
//
//     Hasta $25,000.00    → 1.00%
//     Hasta $50,000.00    → 1.10%
//     Hasta $83,333.33    → 1.50%
//     Hasta $208,333.33   → 2.00%
//     Más de $208,333.33  → 2.50%
//
//   NOTA: RESICO PF usa "ingresos cobrados" (cash basis) no devengado,
//   entonces técnicamente solo deberían contar CFDIs con metodoPago=PUE
//   o CFDIs PPD que ya tienen un complemento de pago en el mes. En v1
//   usamos todos los ingresos stamped del mes como aproximación — el
//   contador puede ajustar manualmente.
//
// PM (Personas Morales, régimen 626): mismo Art. 14 LISR que PMs generales
// pero basado en flujo (cobrado/pagado) no devengado. Coeficiente aplica.
// Nuestra implementación actual con Art. 14 funciona para RESICO PM, solo
// tiene una diferencia conceptual en cash basis que el contador puede
// ajustar vía precierre.
// ─────────────────────────────────────────────────────────────────────────────

type TarifaResicoRow = {
  /** Lower bound inclusive */
  limiteInferior: number;
  /** Upper bound inclusive (or +Infinity) */
  limiteSuperior: number;
  /** Decimal, e.g. 0.010 = 1.00% */
  tasa: number;
  tasaPct: string;
};

export const TARIFA_RESICO_PF_MENSUAL: TarifaResicoRow[] = [
  { limiteInferior: 0.01,       limiteSuperior: 25000.00,   tasa: 0.010, tasaPct: "1.00%" },
  { limiteInferior: 25000.01,   limiteSuperior: 50000.00,   tasa: 0.011, tasaPct: "1.10%" },
  { limiteInferior: 50000.01,   limiteSuperior: 83333.33,   tasa: 0.015, tasaPct: "1.50%" },
  { limiteInferior: 83333.34,   limiteSuperior: 208333.33,  tasa: 0.020, tasaPct: "2.00%" },
  { limiteInferior: 208333.34,  limiteSuperior: Infinity,   tasa: 0.025, tasaPct: "2.50%" },
];

export type IsrResicoPfResult = {
  ingresos: number;
  rangoLimiteInferior: number;
  rangoLimiteSuperior: number;
  tasa: number;
  tasaPct: string;
  isr: number;
};

export function calcularIsrResicoPf(ingresosDelMes: number): IsrResicoPfResult {
  if (ingresosDelMes <= 0) {
    return {
      ingresos: 0,
      rangoLimiteInferior: 0,
      rangoLimiteSuperior: 0,
      tasa: 0,
      tasaPct: "0%",
      isr: 0,
    };
  }
  const row = TARIFA_RESICO_PF_MENSUAL.find(
    (r) => ingresosDelMes >= r.limiteInferior && ingresosDelMes <= r.limiteSuperior
  ) ?? TARIFA_RESICO_PF_MENSUAL[TARIFA_RESICO_PF_MENSUAL.length - 1];
  return {
    ingresos: ingresosDelMes,
    rangoLimiteInferior: row.limiteInferior,
    rangoLimiteSuperior: row.limiteSuperior,
    tasa: row.tasa,
    tasaPct: row.tasaPct,
    isr: +(ingresosDelMes * row.tasa).toFixed(2),
  };
}

/**
 * Determines whether a company is RESICO PF based on its régimen (626) AND
 * RFC length (13 = PF, 12 = PM). Returns "pf" | "pm" | null.
 */
export function detectResicoKind(regimenFiscal: string | null, rfc: string | null): "pf" | "pm" | null {
  if (regimenFiscal !== "626") return null;
  if (!rfc) return null;
  const cleanRfc = rfc.trim().toUpperCase();
  if (cleanRfc.length === 13) return "pf";
  if (cleanRfc.length === 12) return "pm";
  return null;
}
