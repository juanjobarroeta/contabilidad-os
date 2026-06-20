// ─── Declaración Anual PM (Persona Moral Régimen General) ───────────────────
// Art. 9 LISR — Calcula la utilidad fiscal, ISR del ejercicio, y coeficiente
// de utilidad para el ejercicio siguiente.
//
// Also supports PF RESICO (Art. 113-E) and PF Actividad Empresarial.
//
// This is a pure calculation module — no DB calls. The API route feeds it data.

export type DeclaracionAnualInput = {
  ejercicio: number;
  tipoPersona: "PM" | "PF";
  regimenFiscal: string; // "601", "612", "626", etc.

  // ── Ingresos ──
  ingresosPorCfdis: number;         // Sum of CFDI ingresos (subtotal)
  otrosIngresos: number;            // Manual: intereses, ganancia cambiaria, etc.
  ingresosAsimilados?: number;      // Asimilados a salarios recibidos (Art. 94) — acumulable PF

  // ── Deducciones ──
  comprasPorCfdis: number;          // Sum of CFDI egresos (subtotal)
  sueldosYSalarios: number;         // Sum of PayrollItem.totalPercepciones
  cuotasImssPatronal: number;       // Sum of PayrollItem.imssPatronal
  aportacionesInfonavitSar: number; // Employer Infonavit/SAR contributions
  depreciacion: number;             // Manual input (fixed assets)
  otrasDeduccionesAutorizadas: number; // Manual input
  ptuPagado: number;                // PTU distributed to employees

  // ── Ajustes ──
  ajusteInflacionAcumulable: number;   // When deudas > créditos → ingreso
  ajusteInflacionDeducible: number;    // When créditos > deudas → deducción

  // ── Pérdidas ──
  perdidasEjerciciosAnteriores: number; // Actualizadas

  // ── Pagos provisionales ──
  isrPagadoProvisionales: number;      // Sum of monthly ISR provisional payments
  isrRetenidoPorTerceros: number;      // ISR retained by clients (Art. 106)
  isrRetenidoAsimilados?: number;      // ISR retained by the asimilados payer (Art. 94) — acreditable

  // ── RESICO PF specific ──
  resicoPfIngresos?: number;           // For RESICO: total cobrado (not devengado)
};

export type DeclaracionAnualResult = {
  ejercicio: number;
  tipoPersona: "PM" | "PF";
  regimenFiscal: string;

  // ── Determinación de utilidad/pérdida fiscal ──
  totalIngresos: number;
  totalDeducciones: number;
  utilidadOPerdidaFiscal: number;   // ingresos - deducciones
  perdidasAplicadas: number;
  resultadoFiscal: number;          // utilidad - pérdidas anteriores (min 0)

  // ── ISR del ejercicio ──
  tasaIsr: number;                  // 0.30 for PM, progressive for PF
  isrDelEjercicio: number;
  isrAcreditable: number;           // provisionales + retenciones
  isrAPagar: number;                // ISR del ejercicio - acreditable (can be 0)
  isrAFavor: number;                // When acreditable > ISR (refund)

  // ── Coeficiente de utilidad (for next year's provisionales) ──
  coeficienteUtilidad: number | null; // utilidadFiscal / ingresos (null if loss)

  // ── Desglose ──
  desglose: {
    ingresos: {
      porCfdis: number;
      otros: number;
      asimilados: number;
      ajusteInflacionAcumulable: number;
      total: number;
    };
    deducciones: {
      compras: number;
      sueldos: number;
      cuotasImss: number;
      infonavitSar: number;
      depreciacion: number;
      ptu: number;
      ajusteInflacionDeducible: number;
      otras: number;
      total: number;
    };
  };
};

// ── RESICO PF tarifa anual (Art. 113-E) ──────────────────────────────────────
const RESICO_PF_TASA = [
  { hasta: 300000,   tasa: 0.01 },
  { hasta: 600000,   tasa: 0.011 },
  { hasta: 1000000,  tasa: 0.015 },
  { hasta: 2500000,  tasa: 0.02 },
  { hasta: 3500000,  tasa: 0.025 },
  { hasta: Infinity, tasa: 0.025 }, // tope
];

// ── PF General tarifa anual (Art. 152 LISR) ──────────────────────────────────
const TARIFA_ANUAL_PF = [
  { limiteInf: 0.01,      limiteSup: 8952.49,     cuotaFija: 0,         tasa: 0.0192 },
  { limiteInf: 8952.50,   limiteSup: 75984.55,    cuotaFija: 171.88,    tasa: 0.0640 },
  { limiteInf: 75984.56,  limiteSup: 133536.07,   cuotaFija: 4461.94,   tasa: 0.1088 },
  { limiteInf: 133536.08, limiteSup: 155229.80,   cuotaFija: 10723.55,  tasa: 0.16 },
  { limiteInf: 155229.81, limiteSup: 185852.57,   cuotaFija: 14194.54,  tasa: 0.1792 },
  { limiteInf: 185852.58, limiteSup: 374837.88,   cuotaFija: 19682.13,  tasa: 0.2136 },
  { limiteInf: 374837.89, limiteSup: 590795.99,   cuotaFija: 60049.40,  tasa: 0.2352 },
  { limiteInf: 590796.00, limiteSup: 1127926.84,  cuotaFija: 110842.74, tasa: 0.30 },
  { limiteInf: 1127926.85,limiteSup: 1503902.46,  cuotaFija: 271981.99, tasa: 0.32 },
  { limiteInf: 1503902.47,limiteSup: 4511707.37,  cuotaFija: 392294.17, tasa: 0.34 },
  { limiteInf: 4511707.38,limiteSup: Infinity,    cuotaFija: 1414947.85,tasa: 0.35 },
];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calcularDeclaracionAnual(input: DeclaracionAnualInput): DeclaracionAnualResult {
  const { ejercicio, tipoPersona, regimenFiscal } = input;

  // ── Ingresos acumulables ──
  const ingresoCfdis = input.ingresosPorCfdis;
  const otrosIngresos = input.otrosIngresos;
  const ingresosAsimilados = input.ingresosAsimilados ?? 0;
  const ajusteInflAcum = input.ajusteInflacionAcumulable;
  const totalIngresos = r2(ingresoCfdis + otrosIngresos + ingresosAsimilados + ajusteInflAcum);

  // ── Deducciones autorizadas ──
  const compras = input.comprasPorCfdis;
  const sueldos = input.sueldosYSalarios;
  const imss = input.cuotasImssPatronal;
  const infonavit = input.aportacionesInfonavitSar;
  const depreciacion = input.depreciacion;
  const ptu = input.ptuPagado;
  const ajusteInflDed = input.ajusteInflacionDeducible;
  const otras = input.otrasDeduccionesAutorizadas;
  const totalDeducciones = r2(compras + sueldos + imss + infonavit + depreciacion + ptu + ajusteInflDed + otras);

  // ── Utilidad / Pérdida fiscal ──
  const utilidadOPerdida = r2(totalIngresos - totalDeducciones);

  // Apply prior year losses (only if there's a profit)
  const perdidasAplicadas = utilidadOPerdida > 0
    ? r2(Math.min(input.perdidasEjerciciosAnteriores, utilidadOPerdida))
    : 0;
  const resultadoFiscal = r2(Math.max(0, utilidadOPerdida - perdidasAplicadas));

  // ── ISR del ejercicio ──
  let tasaIsr: number;
  let isrDelEjercicio: number;

  if (tipoPersona === "PM") {
    // PM: flat 30% (Art. 9 LISR)
    tasaIsr = 0.30;
    isrDelEjercicio = r2(resultadoFiscal * 0.30);
  } else if (regimenFiscal === "626") {
    // RESICO PF: progressive table on total income (Art. 113-E)
    const ingresos = input.resicoPfIngresos ?? totalIngresos;
    const bracket = RESICO_PF_TASA.find(b => ingresos <= b.hasta) ?? RESICO_PF_TASA[RESICO_PF_TASA.length - 1];
    tasaIsr = bracket.tasa;
    isrDelEjercicio = r2(ingresos * bracket.tasa);
  } else {
    // PF General: progressive tariff (Art. 152 LISR)
    const bracket = TARIFA_ANUAL_PF.find(b => resultadoFiscal >= b.limiteInf && resultadoFiscal <= b.limiteSup)
      ?? TARIFA_ANUAL_PF[TARIFA_ANUAL_PF.length - 1];
    const excedente = resultadoFiscal - bracket.limiteInf;
    isrDelEjercicio = r2(bracket.cuotaFija + excedente * bracket.tasa);
    tasaIsr = resultadoFiscal > 0 ? r2(isrDelEjercicio / resultadoFiscal) : 0;
  }

  // ── ISR acreditable ──
  const isrAcreditable = r2(input.isrPagadoProvisionales + input.isrRetenidoPorTerceros + (input.isrRetenidoAsimilados ?? 0));
  const isrAPagar = r2(Math.max(0, isrDelEjercicio - isrAcreditable));
  const isrAFavor = r2(Math.max(0, isrAcreditable - isrDelEjercicio));

  // ── Coeficiente de utilidad (for next year, Art. 14 LISR) ──
  // CU = (utilidad fiscal + deducción inmediata) / ingresos nominales
  // Simplified: utilidadFiscal / ingresos
  const coeficienteUtilidad = totalIngresos > 0 && utilidadOPerdida > 0
    ? r2((utilidadOPerdida / totalIngresos) * 10000) / 10000 // 4 decimals
    : null;

  return {
    ejercicio,
    tipoPersona,
    regimenFiscal,
    totalIngresos,
    totalDeducciones,
    utilidadOPerdidaFiscal: utilidadOPerdida,
    perdidasAplicadas,
    resultadoFiscal,
    tasaIsr,
    isrDelEjercicio,
    isrAcreditable,
    isrAPagar,
    isrAFavor,
    coeficienteUtilidad,
    desglose: {
      ingresos: {
        porCfdis: ingresoCfdis,
        otros: otrosIngresos,
        asimilados: ingresosAsimilados,
        ajusteInflacionAcumulable: ajusteInflAcum,
        total: totalIngresos,
      },
      deducciones: {
        compras: compras,
        sueldos: sueldos,
        cuotasImss: imss,
        infonavitSar: infonavit,
        depreciacion: depreciacion,
        ptu: ptu,
        ajusteInflacionDeducible: ajusteInflDed,
        otras: otras,
        total: totalDeducciones,
      },
    },
  };
}
