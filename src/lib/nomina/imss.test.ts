import { describe, it, expect } from "vitest";
import { calcularImss } from "./imss";
import {
  ceavPatronalRate,
  CEAV_PATRONAL_TABLAS,
  UMA_DIARIO,
  UMA_DIARIO_2025,
  UMA_EJERCICIO,
  SALARIO_MINIMO_GENERAL,
} from "./constants";

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// UMA de referencia por ejercicio (mismas que CEAV_REFERENCIAS).
const UMA_2026 = UMA_DIARIO; // 117.31 salvo override por env
const UMA_2025 = UMA_DIARIO_2025; // 113.14
const SM_2026 = SALARIO_MINIMO_GENERAL; // 315.04 salvo override por env

describe("ceavPatronalRate — tabla transitoria (DOF 16-dic-2020), columna 2026", () => {
  it("SBC = 1.00 salario mínimo → conserva 3.150% (banda en SM, no UMA)", () => {
    expect(ceavPatronalRate(SM_2026, 2026)).toBe(0.0315);
  });

  it("SBC = 1.2 UMA → 3.676% (banda 1.01-1.50 UMA)... salvo que 1.2 UMA < 1 SM: aplica el piso", () => {
    // OJO: en 2026, 1.2 UMA ($140.77) es MENOR que el salario mínimo
    // ($315.04), así que un SBC así cae en la banda ≤ 1 SM (3.150%). La banda
    // 1.01-1.50 UMA es hoy inoperante para el mínimo general — exactamente la
    // inconsistencia SM/UMA documentada de la tabla del DOF.
    expect(ceavPatronalRate(1.2 * UMA_2026, 2026)).toBe(0.0315);
  });

  it("SBC = 1.8 UMA → también bajo 1 SM en 2026 → 3.150%", () => {
    expect(ceavPatronalRate(1.8 * UMA_2026, 2026)).toBe(0.0315);
  });

  it("SBC apenas arriba de 1 SM (2.69 UMA) → 6.026% (banda 2.51-3.00 UMA)", () => {
    expect(ceavPatronalRate(SM_2026 + 0.01, 2026)).toBe(0.06026);
  });

  it("SBC = 3.2 UMA → 6.361% (banda 3.01-3.50)", () => {
    expect(ceavPatronalRate(3.2 * UMA_2026, 2026)).toBe(0.06361);
  });

  it("SBC = 5 UMA → 7.513% (banda 4.01 en adelante)", () => {
    expect(ceavPatronalRate(5 * UMA_2026, 2026)).toBe(0.07513);
  });

  it("frontera exacta: 3.50 UMA → 6.361%; 3.51 UMA → 6.613%", () => {
    expect(ceavPatronalRate(3.5 * UMA_2026, 2026)).toBe(0.06361);
    expect(ceavPatronalRate(3.51 * UMA_2026, 2026)).toBe(0.06613);
  });

  it("frontera exacta: 4.00 UMA → 6.613%; 4.01 UMA → 7.513%", () => {
    expect(ceavPatronalRate(4.0 * UMA_2026, 2026)).toBe(0.06613);
    expect(ceavPatronalRate(4.01 * UMA_2026, 2026)).toBe(0.07513);
  });

  it("SBC topado a 25 UMA → banda máxima 7.513%", () => {
    expect(ceavPatronalRate(25 * UMA_2026, 2026)).toBe(0.07513);
  });
});

describe("ceavPatronalRate — columna 2025", () => {
  it("SBC = 1.00 salario mínimo 2025 ($278.80) → 3.150%", () => {
    expect(ceavPatronalRate(278.8, 2025)).toBe(0.0315);
  });

  it("SBC = 1.2 / 1.8 UMA 2025 → bajo 1 SM 2025 → 3.150%", () => {
    expect(ceavPatronalRate(1.2 * UMA_2025, 2025)).toBe(0.0315);
    expect(ceavPatronalRate(1.8 * UMA_2025, 2025)).toBe(0.0315);
  });

  it("SBC apenas arriba de 1 SM 2025 (2.46 UMA) → 4.954% (banda 2.01-2.50)", () => {
    expect(ceavPatronalRate(278.81, 2025)).toBe(0.04954);
  });

  it("SBC = 2.7 UMA → 5.307%; 3.2 UMA → 5.559%; 3.8 UMA → 5.747%", () => {
    expect(ceavPatronalRate(2.7 * UMA_2025, 2025)).toBe(0.05307);
    expect(ceavPatronalRate(3.2 * UMA_2025, 2025)).toBe(0.05559);
    expect(ceavPatronalRate(3.8 * UMA_2025, 2025)).toBe(0.05747);
  });

  it("SBC = 5 UMA → 6.422% (vs 7.513% de 2026: la columna del año importa)", () => {
    expect(ceavPatronalRate(5 * UMA_2025, 2025)).toBe(0.06422);
    expect(ceavPatronalRate(5 * UMA_2025, 2025)).not.toBe(
      ceavPatronalRate(5 * UMA_2026, 2026)
    );
  });

  it("frontera exacta 2025: 4.00 UMA → 5.747%; 4.01 UMA → 6.422%", () => {
    expect(ceavPatronalRate(4.0 * UMA_2025, 2025)).toBe(0.05747);
    expect(ceavPatronalRate(4.01 * UMA_2025, 2025)).toBe(0.06422);
  });
});

describe("ceavPatronalRate — bandas UMA operantes con SM histórico bajo (2023/2024)", () => {
  // En 2023 (SM $207.44, UMA $103.74 → 1 SM = 2.0 UMA) las bandas bajas sí
  // operan y podemos probar los cortes 1.50/1.51 UMA del enunciado del DOF.
  it("2023: 1.50 UMA exacto ($155.61) — arriba de... no: bajo 1 SM → 3.150%", () => {
    expect(ceavPatronalRate(1.5 * 103.74, 2023)).toBe(0.0315);
  });

  it("2023: 2.2 UMA → 3.751% (banda 2.01-2.50); 5 UMA → 4.241%", () => {
    expect(ceavPatronalRate(2.2 * 103.74, 2023)).toBe(0.03751);
    expect(ceavPatronalRate(5 * 103.74, 2023)).toBe(0.04241);
  });

  it("2023: frontera 2.50 UMA → 3.751%; 2.51 UMA → 3.869%", () => {
    expect(ceavPatronalRate(2.5 * 103.74, 2023)).toBe(0.03751);
    expect(ceavPatronalRate(2.51 * 103.74, 2023)).toBe(0.03869);
  });

  it("2024: 5 UMA → 5.331%; 2.4 UMA → 4.353%", () => {
    expect(ceavPatronalRate(5 * 108.57, 2024)).toBe(0.05331);
    expect(ceavPatronalRate(2.4 * 108.57, 2024)).toBe(0.04353);
  });
});

describe("ceavPatronalRate — vigencias y guardias", () => {
  it("ejercicio ≤ 2022 → 3.150% fijo (régimen previo a la reforma)", () => {
    expect(ceavPatronalRate(5 * 96.22, 2022)).toBe(0.0315);
    expect(ceavPatronalRate(1000, 2010)).toBe(0.0315);
  });

  it("ejercicio 2027 sin UMA/SM de referencia → lanza Error (nunca tasas silenciosamente mal clasificadas)", () => {
    expect(() => ceavPatronalRate(500, 2027)).toThrow(/CEAV 2027/);
  });

  it("ejercicio 2027 CON referencias explícitas → usa la columna 2027", () => {
    const refs = { umaDiaria: 100, salarioMinimoDiario: 250 };
    expect(ceavPatronalRate(500, 2027, refs)).toBe(0.08603); // 5 UMA
    expect(ceavPatronalRate(300, 2027, refs)).toBe(0.06745); // 3 UMA
    expect(ceavPatronalRate(240, 2027, refs)).toBe(0.0315); // ≤ 1 SM
  });

  it("ejercicio 2030 → columna final; 2031 → sigue rigiendo la columna 2030 (Art. 168 definitivo)", () => {
    const refs = { umaDiaria: 100, salarioMinimoDiario: 250 };
    expect(ceavPatronalRate(500, 2030, refs)).toBe(0.11875);
    expect(ceavPatronalRate(500, 2031, refs)).toBe(0.11875);
    expect(ceavPatronalRate(260, 2030, refs)).toBe(0.08902); // 2.6 UMA, banda 2.51-3.00
  });

  it("todas las columnas 2023-2030 existen y están verificadas", () => {
    const ejercicios = CEAV_PATRONAL_TABLAS.map((t) => t.ejercicio);
    expect(ejercicios).toEqual([2023, 2024, 2025, 2026, 2027, 2028, 2029, 2030]);
    for (const t of CEAV_PATRONAL_TABLAS) {
      expect(t.verificado).toBe(true);
      expect(t.tasaHastaUnSm).toBe(0.0315);
      expect(t.bandas).toHaveLength(7);
      expect(t.bandas[t.bandas.length - 1].hastaUma).toBeNull();
    }
  });
});

describe("calcularImss — integración: CEAV patronal progresiva, demás ramos intactos", () => {
  const input = {
    salarioBaseCotizacion: 500, // 4.26 UMA 2026 → banda 4.01+ (7.513%)
    diasPagados: 15,
    riesgoPuesto: "1",
    ejercicio: 2026,
  };
  const sbcPeriodo = 500 * 15; // 7,500

  it("CEAV patronal usa la tasa progresiva (7.513%), ya NO el 3.150% plano", () => {
    const r = calcularImss(input);
    expect(r.patronal.cesantiaVejez).toBe(r2(sbcPeriodo * 0.07513)); // 563.48
    expect(r.patronal.cesantiaVejez).not.toBe(r2(sbcPeriodo * 0.0315)); // 236.25 (tasa vieja)
  });

  it("CEAV obrera sigue fija en 1.125% — la reforma no la tocó", () => {
    const r = calcularImss(input);
    expect(r.obrero.cesantiaVejez).toBe(r2(sbcPeriodo * 0.01125)); // 84.38
  });

  it("los demás ramos patronales no cambian (EyM, IyV, retiro, guarderías, RT)", () => {
    const r = calcularImss(input);
    const excedente = (500 - 3 * UMA_DIARIO) * 15;
    expect(r.patronal.eymEspecieFija).toBe(r2(UMA_DIARIO * 15 * 0.204));
    expect(r.patronal.eymEspecieExcedente).toBe(r2(excedente * 0.011));
    expect(r.patronal.eymDinero).toBe(r2(sbcPeriodo * 0.007));
    expect(r.patronal.eymGastosMedicos).toBe(r2(sbcPeriodo * 0.0105));
    expect(r.patronal.invalidezVida).toBe(r2(sbcPeriodo * 0.0175));
    expect(r.patronal.retiro).toBe(r2(sbcPeriodo * 0.02));
    expect(r.patronal.guarderias).toBe(r2(sbcPeriodo * 0.01));
    expect(r.patronal.riesgoTrabajo).toBe(r2(sbcPeriodo * 0.0054355));
  });

  it("entre 2025 y 2026 SÓLO cambia la CEAV patronal (y el total)", () => {
    const r25 = calcularImss({ ...input, ejercicio: 2025 });
    const r26 = calcularImss(input);
    // 500 / 113.14 = 4.42 UMA 2025 → 6.422%
    expect(r25.patronal.cesantiaVejez).toBe(r2(sbcPeriodo * 0.06422));
    expect(r26.patronal.cesantiaVejez).toBe(r2(sbcPeriodo * 0.07513));
    for (const campo of [
      "eymEspecieFija",
      "eymEspecieExcedente",
      "eymDinero",
      "eymGastosMedicos",
      "invalidezVida",
      "retiro",
      "guarderias",
      "riesgoTrabajo",
    ] as const) {
      expect(r25.patronal[campo]).toBe(r26.patronal[campo]);
      expect(r25.obrero[campo]).toBe(r26.obrero[campo]);
    }
    expect(r25.obrero.cesantiaVejez).toBe(r26.obrero.cesantiaVejez);
    expect(r25.patronal.total).not.toBe(r26.patronal.total);
    expect(r25.obrero.total).toBe(r26.obrero.total);
  });

  it("el total patronal suma el componente progresivo", () => {
    const r = calcularImss(input);
    const suma = r2(
      r.patronal.eymEspecieFija +
        r.patronal.eymEspecieExcedente +
        r.patronal.eymDinero +
        r.patronal.eymGastosMedicos +
        r.patronal.invalidezVida +
        r.patronal.retiro +
        r.patronal.cesantiaVejez +
        r.patronal.guarderias +
        r.patronal.riesgoTrabajo
    );
    expect(r.patronal.total).toBe(suma);
  });

  it("sin `ejercicio` explícito usa UMA_EJERCICIO (año de las constantes vigentes)", () => {
    const sinEjercicio = calcularImss({
      salarioBaseCotizacion: 500,
      diasPagados: 15,
      riesgoPuesto: "1",
    });
    const conEjercicio = calcularImss({ ...input, ejercicio: UMA_EJERCICIO });
    expect(sinEjercicio.patronal.cesantiaVejez).toBe(conEjercicio.patronal.cesantiaVejez);
    expect(sinEjercicio.patronal.total).toBe(conEjercicio.patronal.total);
  });

  it("trabajador con SBC = 1 SM: cuota patronal CEAV se queda en 3.150%", () => {
    const r = calcularImss({
      salarioBaseCotizacion: SM_2026,
      diasPagados: 15,
      riesgoPuesto: "1",
      ejercicio: 2026,
    });
    expect(r.patronal.cesantiaVejez).toBe(r2(SM_2026 * 15 * 0.0315));
  });
});
