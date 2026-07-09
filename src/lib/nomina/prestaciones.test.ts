// ─── Pruebas doradas: horas extra y prima vacacional por días ────────────────
// Valores 2026: UMA diaria $117.31 (INEGI, vigente 1-feb-2026); salario mínimo
// general $315.04 (CONASAMI). Base legal en prestaciones.ts:
// - LFT Arts. 66-68 (límite de jornada extraordinaria: 3 h/día, 3 veces/semana
//   = 9 h dobles/semana; el excedente se paga triple).
// - LISR Art. 93 fracc. I (salario mínimo: 100% exento dentro del límite LFT;
//   demás trabajadores: 50% exento con tope de 5 UMA por semana).
// - LFT Art. 80 y LISR Art. 93 fracc. XIV (prima vacacional 25%, exención
//   15 UMA).

import { describe, it, expect } from "vitest";
import { calcularAguinaldo, calcularFactorIntegracion, calcularHorasExtra, calcularPrimaVacacionalPorDias } from "./prestaciones";

describe("calcularHorasExtra — Art. 93 fracc. I LISR / LFT Arts. 66-68", () => {
  it("trabajador de salario mínimo: dobles dentro del límite 100% exentas", () => {
    // Salario mínimo 2026: 315.04 → valor hora = 39.38. 6 dobles en quincena.
    const r = calcularHorasExtra({
      salarioDiario: 315.04,
      horasDobles: 6,
      diasPeriodo: 15,
    });
    expect(r.semanas).toBe(2);
    expect(r.exentoSalarioMinimo).toBe(true);
    expect(r.pagoDobles).toBe(472.56); // 6 × 39.38 × 2
    expect(r.montoExento).toBe(472.56); // 100% exento (dentro de 18 h límite)
    expect(r.montoGravado).toBe(0);
  });

  it("trabajador de salario mínimo: triples 100% gravadas", () => {
    const r = calcularHorasExtra({
      salarioDiario: 315.04,
      horasDobles: 6,
      horasTriples: 2,
      diasPeriodo: 15,
    });
    expect(r.pagoTriples).toBe(236.28); // 2 × 39.38 × 3
    expect(r.montoTotal).toBe(708.84);
    expect(r.montoExento).toBe(472.56); // sólo las dobles dentro del límite
    expect(r.montoGravado).toBe(236.28);
  });

  it("trabajador ordinario: 50% exento cuando no rebasa 5 UMA/semana", () => {
    // Salario 600 → hora 75. 8 dobles en quincena (2 semanas): pago 1,200.
    // 50% = 600 ≤ tope 5 × 117.31 × 2 = 1,173.10 → exento 600.
    const r = calcularHorasExtra({
      salarioDiario: 600,
      horasDobles: 8,
      diasPeriodo: 15,
    });
    expect(r.exentoSalarioMinimo).toBe(false);
    expect(r.pagoDobles).toBe(1200);
    expect(r.montoExento).toBe(600);
    expect(r.montoGravado).toBe(600);
  });

  it("trabajador ordinario: la exención se topa en 5 UMA por semana", () => {
    // Salario 3,000 → hora 375. 18 dobles en quincena = justo el límite LFT
    // (9 × 2 semanas). Pago 13,500; 50% = 6,750 > tope 1,173.10.
    const r = calcularHorasExtra({
      salarioDiario: 3000,
      horasDobles: 18,
      diasPeriodo: 15,
    });
    expect(r.horasDoblesDentroLimite).toBe(18);
    expect(r.pagoDobles).toBe(13500);
    expect(r.montoExento).toBe(1173.1); // 5 UMA × 2 semanas
    expect(r.montoGravado).toBe(12326.9);
  });

  it("dobles fuera del límite LFT no gozan de exención", () => {
    // Salario 400 → hora 50. 22 dobles en quincena; límite 18 → 4 fuera.
    // Pago total 2,200; dentro del límite 1,800; 50% = 900 ≤ tope 1,173.10.
    const r = calcularHorasExtra({
      salarioDiario: 400,
      horasDobles: 22,
      diasPeriodo: 15,
    });
    expect(r.horasDoblesDentroLimite).toBe(18);
    expect(r.pagoDobles).toBe(2200);
    expect(r.montoExento).toBe(900); // sin límite habría sido 1,100
    expect(r.montoGravado).toBe(1300);
  });

  it("periodo semanal: una sola semana de límite y de tope UMA", () => {
    // Salario 600 → hora 75. 10 dobles en 7 días: límite 9; dentro = 9 →
    // pago dentro 1,350; 50% = 675 > tope 5 × 117.31 = 586.55.
    const r = calcularHorasExtra({
      salarioDiario: 600,
      horasDobles: 10,
      diasPeriodo: 7,
    });
    expect(r.semanas).toBe(1);
    expect(r.horasDoblesDentroLimite).toBe(9);
    expect(r.pagoDobles).toBe(1500);
    expect(r.montoExento).toBe(586.55);
    expect(r.montoGravado).toBe(913.45);
  });
});

describe("calcularPrimaVacacionalPorDias — Art. 80 LFT / Art. 93 fracc. XIV LISR", () => {
  it("prima por debajo de 15 UMA: totalmente exenta", () => {
    // Salario 800, 6 días: prima = 6 × 800 × 0.25 = 1,200 < 1,759.65.
    const r = calcularPrimaVacacionalPorDias({ salarioDiario: 800, diasVacaciones: 6 });
    expect(r.monto).toBe(1200);
    expect(r.exenta).toBe(1200);
    expect(r.gravada).toBe(0);
  });

  it("frontera de la exención de 15 UMA (1,759.65 en 2026)", () => {
    // Salario 1,200, 6 días: prima = 1,800 → exenta 1,759.65, gravada 40.35.
    const r = calcularPrimaVacacionalPorDias({ salarioDiario: 1200, diasVacaciones: 6 });
    expect(r.monto).toBe(1800);
    expect(r.exenta).toBe(1759.65); // 15 × 117.31
    expect(r.gravada).toBe(40.35);
  });

  it("respeta un porcentaje de prima superior al mínimo", () => {
    const r = calcularPrimaVacacionalPorDias({
      salarioDiario: 500,
      diasVacaciones: 6,
      primaVacacionalPct: 0.5,
    });
    expect(r.monto).toBe(1500); // 6 × 500 × 0.50
    expect(r.exenta).toBe(1500);
    expect(r.gravada).toBe(0);
  });
});

// ─── Pruebas doradas: aguinaldo (Art. 87 LFT / Art. 93 fracc. XIV LISR) ──────
// Mínimo 15 días de salario; proporcional a los días trabajados del ejercicio
// para quien no cumplió el año (divisor 365); exención de 30 UMA diarias
// (2026: 30 × 117.31 = $3,519.30).

describe("calcularAguinaldo — Art. 87 LFT / exención 30 UMA", () => {
  it("año completo con los 15 días mínimos de ley", () => {
    const r = calcularAguinaldo({
      salarioDiario: 400,
      fechaIngreso: new Date("2020-01-15"),
      fechaCorte: new Date("2026-12-31"),
    });
    expect(r.diasTrabajadosEjercicio).toBe(365);
    expect(r.diasCorrespondientes).toBe(15);
    expect(r.montoTotal).toBe(6000); // 400 × 15
    expect(r.montoExento).toBe(3519.3); // 30 × 117.31
    expect(r.montoGravado).toBe(2480.7);
  });

  it("alta a mitad de año (1-jul): proporcional 184/365", () => {
    const r = calcularAguinaldo({
      salarioDiario: 400,
      fechaIngreso: new Date("2026-07-01"),
      fechaCorte: new Date("2026-12-31"),
    });
    expect(r.diasTrabajadosEjercicio).toBe(184); // 1-jul a 31-dic inclusive
    expect(r.diasCorrespondientes).toBe(7.56); // 184/365 × 15
    expect(r.montoTotal).toBe(3024); // 7.56 × 400
    expect(r.montoExento).toBe(3024); // por debajo de 30 UMA: todo exento
    expect(r.montoGravado).toBe(0);
  });

  it("empresa que da 30 días de aguinaldo (superior al mínimo)", () => {
    const r = calcularAguinaldo({
      salarioDiario: 400,
      fechaIngreso: new Date("2019-03-01"),
      fechaCorte: new Date("2026-12-31"),
      diasAguinaldo: 30,
    });
    expect(r.diasCorrespondientes).toBe(30);
    expect(r.montoTotal).toBe(12000);
    expect(r.montoExento).toBe(3519.3);
    expect(r.montoGravado).toBe(8480.7);
  });

  it("frontera de la exención de 30 UMA ($3,519.30 en 2026)", () => {
    // 234.62 × 15 = 3,519.30 exacto → gravado 0.
    const justo = calcularAguinaldo({
      salarioDiario: 234.62,
      fechaIngreso: new Date("2020-01-01"),
      fechaCorte: new Date("2026-12-31"),
    });
    expect(justo.montoTotal).toBe(3519.3);
    expect(justo.montoGravado).toBe(0);
    // 235 × 15 = 3,525 → grava sólo el excedente de 5.70.
    const excede = calcularAguinaldo({
      salarioDiario: 235,
      fechaIngreso: new Date("2020-01-01"),
      fechaCorte: new Date("2026-12-31"),
    });
    expect(excede.montoTotal).toBe(3525);
    expect(excede.montoExento).toBe(3519.3);
    expect(excede.montoGravado).toBe(5.7);
  });

  it("monto ajustado a mano (vista previa): sustituye la fórmula pero la exención se recalcula", () => {
    const r = calcularAguinaldo({
      salarioDiario: 400,
      fechaIngreso: new Date("2020-01-15"),
      fechaCorte: new Date("2026-12-31"),
      montoOverride: 10000,
    });
    expect(r.montoTotal).toBe(10000);
    expect(r.montoExento).toBe(3519.3); // nunca se captura a mano
    expect(r.montoGravado).toBe(6480.7);
    expect(r.diasCorrespondientes).toBe(15); // informativo, sigue reportándose
  });

  it("acepta la UMA del ejercicio de pago (histórica) para la exención", () => {
    const r = calcularAguinaldo({
      salarioDiario: 400,
      fechaIngreso: new Date("2020-01-15"),
      fechaCorte: new Date("2025-12-31"),
      umaDiaria: 113.14, // UMA 2025
    });
    expect(r.montoExento).toBe(3394.2); // 30 × 113.14
    expect(r.montoGravado).toBe(2605.8);
  });
});

describe("calcularFactorIntegracion — vacaciones reforma 2023, año de servicio en curso", () => {
  // El factor integra las prestaciones del año que el trabajador está
  // DEVENGANDO (años cumplidos + 1), como lo esperan las modificaciones de SBC
  // ante el IMSS. Con la reforma de vacaciones 2023 (Art. 76 LFT), año 1 = 12
  // días → factor mínimo 1.0493 (NO el 1.0452 pre-reforma).
  it("año 1 (recién contratado): 12 días de vacaciones → 1.0493", () => {
    const f = calcularFactorIntegracion(new Date("2026-01-01"), new Date("2026-07-01"));
    expect(f).toBe(1.0493);
  });

  it("caso real: salario mínimo 315.04 × factor año 1 = SBC 330.57 (no 329.28)", () => {
    const f = calcularFactorIntegracion(new Date("2026-02-01"), new Date("2026-07-08"));
    expect(+(315.04 * f).toFixed(2)).toBe(330.57);
  });

  it("1 año cumplido (entra al año 2): 14 días → 1.0507", () => {
    const f = calcularFactorIntegracion(new Date("2025-03-01"), new Date("2026-07-01"));
    expect(f).toBe(1.0507);
  });

  it("5 años cumplidos (entra al año 6): 22 días → 1.0562", () => {
    const f = calcularFactorIntegracion(new Date("2021-01-15"), new Date("2026-07-01"));
    expect(f).toBe(1.0562);
  });

  it("prestaciones superiores a la ley: aguinaldo 30 días, año 1 → 1.0904", () => {
    const f = calcularFactorIntegracion(new Date("2026-01-01"), new Date("2026-07-01"), 30);
    expect(f).toBe(1.0904);
  });
});
