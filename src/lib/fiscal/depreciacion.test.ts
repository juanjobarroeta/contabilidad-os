import { describe, it, expect } from "vitest";
import {
  calcularDepreciacionEjercicio,
  mesesUsoEnEjercicio,
  tipoActivoDesdeSubtipo,
  TASA_DEPRECIACION,
  TOPE_AUTOMOVIL,
  TOPE_AUTOMOVIL_ELECTRICO,
} from "./depreciacion";

// Este motor alimenta la deducción del ISR y no tenía una sola prueba directa:
// lo único que lo tocaba era el test de la depreciación CONTABLE, que corre por
// la otra rama —sin tope de automóvil y sin INPC— y de hecho lo que verifica
// del tope es que NO se aplique.

const dia = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("mesesUsoEnEjercicio() — Art. 31", () => {
  it("el mes de alta cuenta completo", () => {
    expect(mesesUsoEnEjercicio(dia("2026-03-20"), 2026)).toBe(10); // mar–dic
    expect(mesesUsoEnEjercicio(dia("2026-01-01"), 2026)).toBe(12);
    expect(mesesUsoEnEjercicio(dia("2026-12-31"), 2026)).toBe(1);
  });

  it("ejercicios completos posteriores son 12; antes de existir, 0", () => {
    expect(mesesUsoEnEjercicio(dia("2026-03-20"), 2027)).toBe(12);
    expect(mesesUsoEnEjercicio(dia("2026-03-20"), 2025)).toBe(0);
  });

  it("con baja se deduce hasta el mes INMEDIATO ANTERIOR", () => {
    expect(mesesUsoEnEjercicio(dia("2024-01-10"), 2026, dia("2026-05-09"))).toBe(4); // ene–abr
    // Baja en enero: no hay mes completo que deducir en ese ejercicio.
    expect(mesesUsoEnEjercicio(dia("2024-01-10"), 2026, dia("2026-01-15"))).toBe(0);
    // Dado de baja en un ejercicio anterior: nada.
    expect(mesesUsoEnEjercicio(dia("2024-01-10"), 2026, dia("2025-06-01"))).toBe(0);
  });

  it("hastaMes acota el periodo, para los pagos provisionales", () => {
    expect(mesesUsoEnEjercicio(dia("2024-01-10"), 2026, null, 6)).toBe(6);
    expect(mesesUsoEnEjercicio(dia("2026-04-02"), 2026, null, 6)).toBe(3); // abr–jun
  });
});

describe("calcularDepreciacionEjercicio() — tope de automóvil (Art. 36-II)", () => {
  const auto = (over = {}) => ({
    moi: 500000,
    fechaAdquisicion: dia("2026-01-15"),
    tipo: "transporte" as const,
    ejercicio: 2026,
    ...over,
  });

  it("un automóvil de pasajeros depreciar sobre el MOI topado, no sobre lo pagado", () => {
    const r = calcularDepreciacionEjercicio(auto({ esAutomovil: true }));
    expect(r.moiDeducible).toBe(TOPE_AUTOMOVIL);
    expect(r.topeAplicado).toBe(true);
    // 175,000 × 25% × 12/12
    expect(r.depreciacionNominalEjercicio).toBe(43750);
  });

  it("el tope eléctrico es otro", () => {
    const r = calcularDepreciacionEjercicio(auto({ esAutomovil: true, esElectricoHibrido: true }));
    expect(r.moiDeducible).toBe(TOPE_AUTOMOVIL_ELECTRICO);
    expect(r.depreciacionNominalEjercicio).toBe(62500);
  });

  // Una pickup de carga NO es automóvil: se deduce completa.
  it("sin la bandera no hay tope, aunque sea equipo de transporte", () => {
    const r = calcularDepreciacionEjercicio(auto());
    expect(r.topeAplicado).toBe(false);
    expect(r.moiDeducible).toBe(500000);
    expect(r.depreciacionNominalEjercicio).toBe(125000);
  });

  it("por debajo del tope, el tope no se nota", () => {
    const r = calcularDepreciacionEjercicio(auto({ moi: 120000, esAutomovil: true }));
    expect(r.topeAplicado).toBe(false);
    expect(r.moiDeducible).toBe(120000);
  });
});

describe("calcularDepreciacionEjercicio() — saldo y prorrateo", () => {
  const equipo = (over = {}) => ({
    moi: 36000,
    fechaAdquisicion: dia("2026-07-10"),
    tipo: "computo" as const,
    ejercicio: 2026,
    ...over,
  });

  it("el año de alta se prorratea por meses de uso", () => {
    // 36,000 × 30% × 6/12 (jul–dic)
    expect(calcularDepreciacionEjercicio(equipo()).depreciacionNominalEjercicio).toBe(5400);
  });

  it("nunca se deduce más de lo que falta por deducir", () => {
    const r = calcularDepreciacionEjercicio(equipo({ ejercicio: 2030, depreciacionAcumuladaPrevia: 35000 }));
    expect(r.depreciacionNominalEjercicio).toBe(1000);
    expect(r.saldoPendiente).toBe(0);
  });

  it("agotado el MOI, la deducción es cero", () => {
    const r = calcularDepreciacionEjercicio(equipo({ ejercicio: 2031, depreciacionAcumuladaPrevia: 36000 }));
    expect(r.depreciacionNominalEjercicio).toBe(0);
    expect(r.saldoPendiente).toBe(0);
  });

  it("el saldo pendiente baja con lo deducido del ejercicio", () => {
    const r = calcularDepreciacionEjercicio(equipo({ ejercicio: 2027, depreciacionAcumuladaPrevia: 5400 }));
    expect(r.depreciacionNominalEjercicio).toBe(10800); // 36,000 × 30%
    expect(r.saldoPendiente).toBe(36000 - 5400 - 10800);
  });
});

describe("calcularDepreciacionEjercicio() — actualización INPC (Art. 31)", () => {
  const base = {
    moi: 100000,
    fechaAdquisicion: dia("2023-01-15"),
    tipo: "mobiliario" as const,
    ejercicio: 2026,
  };

  it("el factor multiplica la deducción, y el nominal se conserva aparte", () => {
    const r = calcularDepreciacionEjercicio({ ...base, factorInpc: 1.185 });
    expect(r.depreciacionNominalEjercicio).toBe(10000); // 100,000 × 10%
    expect(r.factorActualizacion).toBe(1.185);
    expect(r.depreciacionEjercicio).toBe(11850);
    expect(r.sinActualizar).toBe(false);
  });

  // Sin INPC la cifra queda NOMINAL y marcada, nunca inventada.
  it("sin factor, queda nominal y se marca", () => {
    const r = calcularDepreciacionEjercicio(base);
    expect(r.depreciacionEjercicio).toBe(r.depreciacionNominalEjercicio);
    expect(r.sinActualizar).toBe(true);
    expect(r.factorActualizacion).toBe(1);
  });

  it("el saldo pendiente se lleva en NOMINAL, no actualizado", () => {
    const r = calcularDepreciacionEjercicio({ ...base, factorInpc: 1.185 });
    expect(r.saldoPendiente).toBe(90000);
  });
});

describe("tasas y tipos", () => {
  it("cada tipo trae su tasa y su fundamento", () => {
    expect(TASA_DEPRECIACION.computo.tasa).toBe(0.3);
    expect(TASA_DEPRECIACION.construccion.tasa).toBe(0.05);
    expect(TASA_DEPRECIACION.transporte.tasa).toBe(0.25);
    expect(TASA_DEPRECIACION.herramental.tasa).toBe(0.35);
    // El intangible NO se deprecia: se amortiza (Art. 33).
    expect(TASA_DEPRECIACION.intangible.tasa).toBe(0.15);
    expect(TASA_DEPRECIACION.intangible.fundamento).toContain("33");
    for (const [tipo, v] of Object.entries(TASA_DEPRECIACION)) {
      expect(v.fundamento, tipo).not.toBe("");
      expect(v.tasa, tipo).toBeGreaterThan(0);
      expect(v.tasa, tipo).toBeLessThanOrEqual(1);
    }
  });

  it("la tasa de la ficha manda sobre la del tipo, y lo dice", () => {
    const r = calcularDepreciacionEjercicio({
      moi: 10000,
      fechaAdquisicion: dia("2026-01-01"),
      tipo: "computo",
      ejercicio: 2026,
      tasaOverride: 0.1,
    });
    expect(r.tasaAnual).toBe(0.1);
    expect(r.fundamento).toContain("ficha");
    expect(r.tasaAproximada).toBe(false);
  });

  it("un subtipo desconocido cae en «otro», no revienta", () => {
    expect(tipoActivoDesdeSubtipo("lo que sea")).toBe("otro");
    expect(tipoActivoDesdeSubtipo(null)).toBe("otro");
    expect(tipoActivoDesdeSubtipo("intangible")).toBe("intangible");
  });
});
