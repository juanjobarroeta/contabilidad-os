import { describe, it, expect } from "vitest";
import {
  aplicarPerdidaFiscalPM,
  ptuDisminuiblePM,
  coeficienteDesdeAnual,
  coeficienteAnualConHistorial,
  advertenciasCadenaDeclaraciones,
} from "./impuestos";

// Amortización de pérdidas fiscales de ejercicios anteriores (PM Art. 14 LISR)
// en pagos provisionales: el remanente actualizado se resta de la utilidad
// fiscal estimada antes de aplicar la tasa del 30%.
describe("aplicarPerdidaFiscalPM", () => {
  it("(a) pérdida mayor que la utilidad → base 0", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 46_000,
      perdidaPendiente: 450_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(46_000);
    expect(r.baseGravable).toBe(0);
    // base 0 ⇒ ISR del ejercicio = 0
    expect(r.baseGravable * 0.3).toBe(0);
  });

  it("(b) pérdida parcial → base reducida", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 30_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(30_000);
    expect(r.baseGravable).toBe(70_000);
  });

  it("(c) sin pérdida pendiente → comportamiento sin cambios", () => {
    const sinPerdida = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: null,
      perdidaAnio: null,
      year: 2026,
    });
    expect(sinPerdida.perdidaAplicada).toBe(0);
    expect(sinPerdida.baseGravable).toBe(100_000);

    const cero = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 0,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(cero.perdidaAplicada).toBe(0);
    expect(cero.baseGravable).toBe(100_000);
  });

  it("no aplica si el remanente es del ejercicio en curso o futuro", () => {
    const mismoAnio = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 50_000,
      perdidaAnio: 2026,
      year: 2026,
    });
    expect(mismoAnio.perdidaAplicada).toBe(0);
    expect(mismoAnio.baseGravable).toBe(100_000);
  });

  it("aplica cuando el ejercicio del remanente es null (sin año capturado)", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 100_000,
      perdidaPendiente: 40_000,
      perdidaAnio: null,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(40_000);
    expect(r.baseGravable).toBe(60_000);
  });

  it("utilidad cero o negativa no genera base negativa", () => {
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: 0,
      perdidaPendiente: 50_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(0);
    expect(r.baseGravable).toBe(0);
  });
});

// PTU pagada en el ejercicio disminuible del provisional PM (Art. 14, fracc.
// II, segundo párrafo LISR): por partes iguales en mayo–diciembre, de manera
// acumulativa — mayo 1/8, junio 2/8, …, diciembre 8/8. Enero–abril: nada.
describe("ptuDisminuiblePM", () => {
  const PTU = 80_000;

  it("enero–abril no disminuyen PTU", () => {
    for (const month of [1, 2, 3, 4]) {
      expect(ptuDisminuiblePM({ ptuPagadaEjercicio: PTU, month })).toBe(0);
    }
  });

  it("mayo disminuye 1/8 acumulado", () => {
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: PTU, month: 5 })).toBe(10_000);
  });

  it("agosto disminuye 4/8 acumulados", () => {
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: PTU, month: 8 })).toBe(40_000);
  });

  it("diciembre disminuye 8/8 — la PTU completa", () => {
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: PTU, month: 12 })).toBe(80_000);
  });

  it("PTU nula, cero o negativa → 0", () => {
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: null, month: 8 })).toBe(0);
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: 0, month: 8 })).toBe(0);
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: -5_000, month: 8 })).toBe(0);
  });

  it("octavos no exactos se redondean a centavos", () => {
    // 100 000/8 = 12 500 exacto; usar un monto con residuo: 1 000.01
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: 1_000.01, month: 5 })).toBe(125.0);
    expect(ptuDisminuiblePM({ ptuPagadaEjercicio: 1_000.01, month: 12 })).toBe(1_000.01);
  });

  // Orden del Art. 14, fracc. II: utilidad fiscal − PTU (octavos) primero, y a
  // ESE resultado se le amortiza la pérdida fiscal pendiente. La base nunca es
  // negativa: el excedente de PTU/pérdida sólo lleva la base a cero.
  it("la PTU se disminuye ANTES de las pérdidas fiscales", () => {
    const utilidadFiscal = 100_000;
    const ptu = ptuDisminuiblePM({ ptuPagadaEjercicio: 80_000, month: 8 }); // 40 000
    const utilidadTrasPtu = Math.max(0, utilidadFiscal - ptu); // 60 000
    // La pérdida de 70 000 sólo puede amortizar los 60 000 restantes — si se
    // aplicara antes de la PTU (100 000 − 70 000 = 30 000), la PTU de 40 000
    // taparía todo y se perdería el orden legal.
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: utilidadTrasPtu,
      perdidaPendiente: 70_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(60_000);
    expect(r.baseGravable).toBe(0);
  });

  it("PTU mayor que la utilidad → base cero, nunca negativa", () => {
    const utilidadFiscal = 30_000;
    const ptu = ptuDisminuiblePM({ ptuPagadaEjercicio: 80_000, month: 12 }); // 80 000
    const utilidadTrasPtu = Math.max(0, utilidadFiscal - ptu);
    expect(utilidadTrasPtu).toBe(0);
    const r = aplicarPerdidaFiscalPM({
      utilidadFiscal: utilidadTrasPtu,
      perdidaPendiente: 10_000,
      perdidaAnio: 2025,
      year: 2026,
    });
    expect(r.perdidaAplicada).toBe(0);
    expect(r.baseGravable).toBe(0);
  });
});

// Coeficiente de utilidad (Art. 14, fracc. I LISR) derivado de una declaración
// anual guardada: UTILIDAD FISCAL ÷ ingresos nominales, ANTES de amortizar
// pérdidas — nunca el resultado fiscal entre ingresos.
describe("coeficienteDesdeAnual", () => {
  const base = { periodo: "2025" };

  it("prefiere el isrCoeficienteUtilidad guardado (ya calculado pre-pérdidas)", () => {
    const c = coeficienteDesdeAnual({
      ...base,
      isrCoeficienteUtilidad: 0.1234,
      // Cifras contradictorias a propósito: el guardado gana.
      isrIngresos: 1_000_000,
      isrDeducciones: 990_000,
      isrBaseGravable: 5_000,
    });
    expect(c).toBe(0.1234);
  });

  it("reconstruye la utilidad fiscal como ingresos − deducciones (no usa el resultado fiscal)", () => {
    // Ejercicio con pérdidas amortizadas: utilidad 200k, pérdidas aplicadas
    // 150k → resultado fiscal (isrBaseGravable) 50k. El coeficiente correcto
    // es 200k/1M = 0.2, NO 50k/1M = 0.05.
    const c = coeficienteDesdeAnual({
      ...base,
      isrCoeficienteUtilidad: null,
      isrIngresos: 1_000_000,
      isrDeducciones: 800_000,
      isrBaseGravable: 50_000,
    });
    expect(c).toBe(0.2);
  });

  it("utilidad cero o pérdida → null (Art. 14: se usa el último año CON utilidad)", () => {
    expect(
      coeficienteDesdeAnual({ ...base, isrCoeficienteUtilidad: null, isrIngresos: 1_000_000, isrDeducciones: 1_000_000, isrBaseGravable: 0 })
    ).toBeNull();
    expect(
      coeficienteDesdeAnual({ ...base, isrCoeficienteUtilidad: null, isrIngresos: 500_000, isrDeducciones: 700_000, isrBaseGravable: 0 })
    ).toBeNull();
  });

  it("ingresos cero o null → null (sin división entre cero)", () => {
    expect(
      coeficienteDesdeAnual({ ...base, isrCoeficienteUtilidad: null, isrIngresos: 0, isrDeducciones: 0, isrBaseGravable: 10_000 })
    ).toBeNull();
    expect(
      coeficienteDesdeAnual({ ...base, isrCoeficienteUtilidad: null, isrIngresos: null, isrDeducciones: null, isrBaseGravable: 10_000 })
    ).toBeNull();
    expect(coeficienteDesdeAnual(null)).toBeNull();
  });

  it("fila legacy sin deducciones: último recurso baseGravable ÷ ingresos", () => {
    const c = coeficienteDesdeAnual({
      ...base,
      isrCoeficienteUtilidad: null,
      isrIngresos: 1_000_000,
      isrDeducciones: null,
      isrBaseGravable: 80_000,
    });
    expect(c).toBe(0.08);
  });

  it("redondea al diezmilésimo (Art. 14, fracc. I, último párrafo)", () => {
    const c = coeficienteDesdeAnual({
      ...base,
      isrCoeficienteUtilidad: null,
      isrIngresos: 3_000_000,
      isrDeducciones: 2_800_000, // 200000/3000000 = 0.066666…
      isrBaseGravable: null,
    });
    expect(c).toBe(0.0667);
  });
});

// Arrastre del coeficiente hasta 5 ejercicios atrás (Art. 14, fracc. I,
// segundo párrafo): gana el ejercicio más reciente que arroje coeficiente.
describe("coeficienteAnualConHistorial", () => {
  const anual = (periodo: string, ingresos: number | null, deducciones: number | null, coef: number | null = null) => ({
    periodo,
    isrIngresos: ingresos,
    isrDeducciones: deducciones,
    isrBaseGravable: null,
    isrCoeficienteUtilidad: coef,
  });

  it("usa el ejercicio inmediato anterior cuando tiene utilidad", () => {
    const r = coeficienteAnualConHistorial(
      [anual("2025", 1_000_000, 900_000), anual("2024", 1_000_000, 500_000)],
      2025
    );
    expect(r).toEqual({ coeficiente: 0.1, ejercicio: 2025 });
  });

  it("ejercicio anterior con pérdida → retrocede al último año con utilidad", () => {
    const r = coeficienteAnualConHistorial(
      [anual("2025", 1_000_000, 1_200_000), anual("2023", 2_000_000, 1_500_000)],
      2025
    );
    expect(r).toEqual({ coeficiente: 0.25, ejercicio: 2023 });
  });

  it("no retrocede más de 5 ejercicios", () => {
    // 2020 es el 6º ejercicio hacia atrás respecto de provisionales de 2026
    // (prevYear 2025): queda fuera de la ventana 2025..2021.
    const r = coeficienteAnualConHistorial([anual("2020", 1_000_000, 500_000)], 2025);
    expect(r).toBeNull();
    // 2021 sí entra (5º candidato).
    const r2 = coeficienteAnualConHistorial([anual("2021", 1_000_000, 500_000)], 2025);
    expect(r2).toEqual({ coeficiente: 0.5, ejercicio: 2021 });
  });

  it("sin anuales guardadas → null", () => {
    expect(coeficienteAnualConHistorial([], 2025)).toBeNull();
  });
});

// Avisos de cadena de arrastre rota: mes con CFDIs timbrados sin declaración
// guardada → el saldo a favor de IVA (Art. 6 LIVA) y los pagos provisionales
// de ISR (Art. 14 LISR) se toman en cero sin señal alguna.
describe("advertenciasCadenaDeclaraciones", () => {
  it("cadena íntegra → sin avisos", () => {
    const r = advertenciasCadenaDeclaraciones({
      year: 2026,
      month: 6,
      mesesConActividad: new Set(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]),
      mesesConDeclaracion: new Set(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]),
    });
    expect(r).toEqual([]);
  });

  it("mes anterior con actividad y sin declaración → aviso de IVA + ISR nombrando el mes", () => {
    const r = advertenciasCadenaDeclaraciones({
      year: 2026,
      month: 6,
      mesesConActividad: new Set(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]),
      mesesConDeclaracion: new Set(["2026-01", "2026-02", "2026-03", "2026-04"]),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("mayo de 2026");
    expect(r[0]).toContain("saldo a favor de IVA");
    expect(r[0]).toContain("pagos provisionales de ISR");
  });

  it("primer mes de la empresa (sin actividad previa) → sin avisos", () => {
    const r = advertenciasCadenaDeclaraciones({
      year: 2026,
      month: 4,
      mesesConActividad: new Set(), // la primera factura es de abril
      mesesConDeclaracion: new Set(),
    });
    expect(r).toEqual([]);
  });

  it("enero con diciembre anterior sin declarar → aviso SÓLO de IVA (cruza ejercicios, Art. 6 LIVA)", () => {
    const r = advertenciasCadenaDeclaraciones({
      year: 2026,
      month: 1,
      mesesConActividad: new Set(["2025-12"]),
      mesesConDeclaracion: new Set(),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("diciembre de 2025");
    expect(r[0]).toContain("IVA");
    // El ISR del ejercicio empieza de cero en enero: no debe mencionarse.
    expect(r[0]).not.toContain("ISR");
  });

  it("enero con diciembre declarado (o sin actividad) → sin avisos", () => {
    expect(
      advertenciasCadenaDeclaraciones({
        year: 2026,
        month: 1,
        mesesConActividad: new Set(["2025-12"]),
        mesesConDeclaracion: new Set(["2025-12"]),
      })
    ).toEqual([]);
    expect(
      advertenciasCadenaDeclaraciones({
        year: 2026,
        month: 1,
        mesesConActividad: new Set(),
        mesesConDeclaracion: new Set(),
      })
    ).toEqual([]);
  });

  it("meses anteriores del ejercicio sin declarar → aviso de ISR con la lista de meses", () => {
    const r = advertenciasCadenaDeclaraciones({
      year: 2026,
      month: 6,
      mesesConActividad: new Set(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05"]),
      // Falta feb y mar (anteriores al inmediato) — mayo sí está guardado.
      mesesConDeclaracion: new Set(["2026-01", "2026-04", "2026-05"]),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("febrero de 2026");
    expect(r[0]).toContain("marzo de 2026");
    expect(r[0]).toContain("ISR");
  });

  it("la lista de meses faltantes se acota a un largo legible", () => {
    const r = advertenciasCadenaDeclaraciones({
      year: 2026,
      month: 12,
      mesesConActividad: new Set(
        Array.from({ length: 11 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`)
      ),
      mesesConDeclaracion: new Set(["2026-11"]), // sólo el inmediato guardado
    });
    expect(r).toHaveLength(1);
    // 10 meses faltantes (ene..oct) → 5 nombrados y "y 5 mes(es) más".
    expect(r[0]).toContain("y 5 mes(es) más");
  });

  it("mes anterior sin actividad pero meses viejos sin declarar → sólo el aviso de ISR", () => {
    const r = advertenciasCadenaDeclaraciones({
      year: 2026,
      month: 6,
      mesesConActividad: new Set(["2026-01", "2026-02"]),
      mesesConDeclaracion: new Set(),
    });
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("enero de 2026");
    expect(r[0]).toContain("febrero de 2026");
  });
});
