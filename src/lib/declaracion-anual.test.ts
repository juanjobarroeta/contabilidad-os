import { describe, it, expect } from "vitest";
import { calcularDeclaracionAnual, type DeclaracionAnualInput } from "./declaracion-anual";

// ─── Golden tests: ISR anual PF (Art. 152 LISR) por ejercicio ────────────────
// La tarifa del Art. 152 se actualiza por inflación (Art. 152, último párrafo,
// LISR); la anual 2026 (Anexo 8 RMF 2026, DOF 28-dic-2025) difiere de la
// 2024/2025. La misma base gravable debe producir ISR distinto según el
// ejercicio declarado. Valores calculados A MANO con las filas de
// src/lib/fiscal/tarifas.ts (fórmula: cuotaFija + (base − límiteInferior) ×
// tasa sobre excedente).

/** Input PF Actividad Empresarial (612) con base gravable = ingresos. */
function inputPF(ejercicio: number, ingresos: number): DeclaracionAnualInput {
  return {
    ejercicio,
    tipoPersona: "PF",
    regimenFiscal: "612",
    ingresosPorCfdis: ingresos,
    otrosIngresos: 0,
    comprasPorCfdis: 0,
    sueldosYSalarios: 0,
    cuotasImssPatronal: 0,
    aportacionesInfonavitSar: 0,
    depreciacion: 0,
    otrasDeduccionesAutorizadas: 0,
    ptuPagado: 0,
    ajusteInflacionAcumulable: 0,
    ajusteInflacionDeducible: 0,
    perdidasEjerciciosAnteriores: 0,
    isrPagadoProvisionales: 0,
    isrRetenidoPorTerceros: 0,
  };
}

describe("ISR anual PF Art. 152 — tarifa seleccionada por ejercicio", () => {
  // Base gravable 500,000.00: cae en renglones distintos de cada tabla.
  const BASE = 500_000;

  it("ejercicio 2024: tarifa Anexo 8 RMF 2024", () => {
    // Renglón 2024: LI 374,837.89, cuota fija 60,049.40, 23.52% s/ excedente.
    // 60,049.40 + (500,000 − 374,837.89) × 0.2352
    //   = 60,049.40 + 125,162.11 × 0.2352
    //   = 60,049.40 + 29,438.128272 = 89,487.53
    const r = calcularDeclaracionAnual(inputPF(2024, BASE));
    expect(r.resultadoFiscal).toBe(BASE);
    expect(r.isrDelEjercicio).toBe(89_487.53);
  });

  it("ejercicio 2026: tarifa actualizada Anexo 8 RMF 2026 (distinta a 2024)", () => {
    // Renglón 2026: LI 424,353.98, cuota fija 67,981.92, 23.52% s/ excedente.
    // 67,981.92 + (500,000 − 424,353.98) × 0.2352
    //   = 67,981.92 + 75,646.02 × 0.2352
    //   = 67,981.92 + 17,791.943904 = 85,773.86
    const r = calcularDeclaracionAnual(inputPF(2026, BASE));
    expect(r.resultadoFiscal).toBe(BASE);
    expect(r.isrDelEjercicio).toBe(85_773.86);
    // Misma base, ejercicio distinto → ISR distinto (la actualización 2026
    // reduce el ISR para la misma base nominal).
    expect(r.isrDelEjercicio).not.toBe(89_487.53);
  });

  it("ejercicio 2025: roll-forward a la tabla 2024 (no hubo actualización)", () => {
    // tarifas.ts no tiene registro 2025: tarifaAnualPF resuelve la tabla más
    // reciente anterior (2024), que siguió vigente en 2025.
    const r = calcularDeclaracionAnual(inputPF(2025, BASE));
    expect(r.isrDelEjercicio).toBe(89_487.53);
  });

  it("ejercicio sin tabla aplicable (2023): falla ruidosamente, no calcula", () => {
    // tarifaAnualPF devuelve null para ejercicios anteriores a la primera
    // tabla cargada (2024). No hay fallback silencioso a la tarifa de otro
    // año: el cálculo debe lanzar con el ejercicio en el mensaje.
    expect(() => calcularDeclaracionAnual(inputPF(2023, BASE))).toThrow(/2023/);
    expect(() => calcularDeclaracionAnual(inputPF(2023, BASE))).toThrow(
      /Art\. 152/
    );
  });

  it("base gravable 0: ISR 0 (sin renglón aplicable no se cobra cuota)", () => {
    const r = calcularDeclaracionAnual(inputPF(2024, 0));
    expect(r.resultadoFiscal).toBe(0);
    expect(r.isrDelEjercicio).toBe(0);
    expect(r.isrAPagar).toBe(0);
  });
});

describe("RESICO PF (Art. 113-E) — tabla estatutaria, no versionada", () => {
  it("aplica la tasa de ley sobre ingresos cobrados en cualquier ejercicio", () => {
    // Art. 113-E LISR: hasta 300,000 → 1.00%. Tasas fijadas en ley (reforma
    // DOF 12-nov-2021), sin actualización anual por Anexo 8.
    for (const ejercicio of [2024, 2026]) {
      const r = calcularDeclaracionAnual({
        ...inputPF(ejercicio, 250_000),
        regimenFiscal: "626",
        resicoPfIngresos: 250_000,
      });
      expect(r.tasaIsr).toBe(0.01);
      expect(r.isrDelEjercicio).toBe(2_500);
    }
  });
});
