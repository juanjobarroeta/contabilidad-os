// ─── Declaración Anual PM (Persona Moral Régimen General) ───────────────────
// Art. 9 LISR — Calcula la utilidad fiscal, ISR del ejercicio, y coeficiente
// de utilidad para el ejercicio siguiente.
//
// Supports only the annual engines explicitly enabled in the regimen registry.
//
// This is a pure calculation module — no DB calls. The API route feeds it data.

import { tarifaAnualPF, aplicarTarifa } from "@/lib/fiscal/tarifas";
import { assertAnnualCompanyCalculationSupported } from "@/lib/fiscal/regimen-capabilities";

export type DeclaracionAnualInput = {
  ejercicio: number;
  tipoPersona: "PM" | "PF";
  regimenFiscal: string; // "601", "612", "626", etc.
  /** Full CSF regime set effective for `ejercicio`. Omitted by legacy/internal callers. */
  regimenes?: string[];

  // ── Ingresos ──
  ingresosPorCfdis: number;         // Sum of CFDI ingresos (subtotal)
  otrosIngresos: number;            // Manual: intereses, ganancia cambiaria, etc.
  /** Ganancia en enajenación de activo fijo (Art. 19): ingreso acumulable. */
  gananciaEnajenacion?: number;
  ingresosAsimilados?: number;      // Asimilados a salarios recibidos (Art. 94) — acumulable PF

  // ── Deducciones ──
  comprasPorCfdis: number;          // Sum of CFDI egresos (subtotal)
  sueldosYSalarios: number;         // Sum of PayrollItem.totalPercepciones
  cuotasImssPatronal: number;       // Sum of PayrollItem.imssPatronal
  aportacionesInfonavitSar: number; // Employer Infonavit/SAR contributions
  depreciacion: number;             // Manual input (fixed assets)
  otrasDeduccionesAutorizadas: number; // Manual input
  /** Pérdida en enajenación de activo fijo (Art. 19): deducción autorizada. */
  perdidaEnajenacion?: number;
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
  const regimenTrack = assertAnnualCompanyCalculationSupported({
    regimenFiscal,
    regimenes: input.regimenes,
    tipoPersona,
  });

  // ── Ingresos acumulables ──
  const ingresoCfdis = input.ingresosPorCfdis;
  const otrosIngresos = input.otrosIngresos;
  const ingresosAsimilados = input.ingresosAsimilados ?? 0;
  const ajusteInflAcum = input.ajusteInflacionAcumulable;
  // La ganancia en enajenación de activo fijo es ingreso acumulable (Art. 19):
  // se acumula aparte de los CFDIs, porque la venta de un activo no siempre
  // viaja en una factura de ingreso del ejercicio.
  const gananciaEnajenacion = input.gananciaEnajenacion ?? 0;
  const totalIngresos = r2(ingresoCfdis + otrosIngresos + ingresosAsimilados + ajusteInflAcum + gananciaEnajenacion);

  // ── Deducciones autorizadas ──
  const compras = input.comprasPorCfdis;
  const sueldos = input.sueldosYSalarios;
  const imss = input.cuotasImssPatronal;
  const infonavit = input.aportacionesInfonavitSar;
  const depreciacion = input.depreciacion;
  const ptu = input.ptuPagado;
  const ajusteInflDed = input.ajusteInflacionDeducible;
  const otras = input.otrasDeduccionesAutorizadas;
  // Y la pérdida, deducción autorizada del mismo artículo.
  const perdidaEnajenacion = input.perdidaEnajenacion ?? 0;
  const totalDeducciones = r2(
    compras + sueldos + imss + infonavit + depreciacion + ptu + ajusteInflDed + otras + perdidaEnajenacion,
  );

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

  if (regimenTrack.trackId === "601") {
    // PM: flat 30% (Art. 9 LISR)
    tasaIsr = 0.30;
    isrDelEjercicio = r2(resultadoFiscal * 0.30);
  } else {
    // Only 612 PF reaches this branch: tarifa progresiva del ejercicio (Art. 152 LISR),
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
