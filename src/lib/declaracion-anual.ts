// ─── Declaración Anual PM (Persona Moral Régimen General) ───────────────────
// Art. 9 LISR — Calcula la utilidad fiscal, ISR del ejercicio, y coeficiente
// de utilidad para el ejercicio siguiente.
//
// Also supports PF RESICO (Art. 113-E) and PF Actividad Empresarial.
//
// This is a pure calculation module — no DB calls. The API route feeds it data.

import { tarifaAnualPF, aplicarTarifa } from "@/lib/fiscal/tarifas";

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
// Las tasas y los rangos de esta tabla están fijados en la propia LISR (Art.
// 113-E, reforma DOF 12-nov-2021, vigente desde 2022) y NO se actualizan por
// inflación vía Anexo 8 RMF, así que no requieren versionado por ejercicio
// (a diferencia de las tarifas de los Arts. 96/152).
const RESICO_PF_TASA = [
  { hasta: 300000,   tasa: 0.01 },
  { hasta: 600000,   tasa: 0.011 },
  { hasta: 1000000,  tasa: 0.015 },
  { hasta: 2500000,  tasa: 0.02 },
  { hasta: 3500000,  tasa: 0.025 },
  { hasta: Infinity, tasa: 0.025 }, // tope
];

// ── PF General tarifa anual (Art. 152 LISR) ──────────────────────────────────
// La tarifa vive versionada por ejercicio en src/lib/fiscal/tarifas.ts (fuente
// única, con vigencia y bandera `verificado`); aquí sólo se selecciona la del
// ejercicio declarado vía tarifaAnualPF(ejercicio). El Art. 152, último
// párrafo, LISR obliga a actualizar la tarifa cuando la inflación acumulada
// supera 10% (última actualización: Anexo 8 RMF 2026, DOF 28-dic-2025), por lo
// que usar una tabla fija sería incorrecto para ejercicios distintos.

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
    // PF General: tarifa progresiva del ejercicio declarado (Art. 152 LISR),
    // tomada del módulo versionado de tarifas. tarifaAnualPF resuelve el
    // ejercicio exacto o, en su defecto, la tabla más reciente anterior
    // (roll-forward: la tarifa sigue vigente hasta que el SAT publica la
    // actualización, p.ej. 2025 usa la de 2024). Si no existe ninguna tabla
    // aplicable (ejercicios previos a las cargadas) devuelve null: fallamos
    // ruidosamente en vez de calcular ISR con una tarifa de otro año.
    const tarifa = tarifaAnualPF(ejercicio);
    if (!tarifa) {
      throw new Error(
        `Sin tarifa anual ISR PF (Art. 152 LISR) para el ejercicio ${ejercicio}: ` +
          "no hay tabla aplicable en src/lib/fiscal/tarifas.ts."
      );
    }
    isrDelEjercicio = r2(aplicarTarifa(resultadoFiscal, tarifa.filas));
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
