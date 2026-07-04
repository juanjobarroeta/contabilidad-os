// ─── Pruebas doradas: incidencias en el motor de nómina ──────────────────────
// Verifican el tratamiento fiscal de cada tipo de incidencia dentro de
// calcularNomina (corrida ORDINARIA quincenal, ejercicio 2026):
// - Faltas / incapacidades reducen sueldo Y días de cotización IMSS (Art. 82
//   LFT; Art. 31 LSS — simplificación proporcional documentada en el motor).
// - Horas extra: separación gravado/exento (Art. 93 fracc. I LISR).
// - Prima vacacional de días tomados: exención 15 UMA (Art. 93 fracc. XIV).
// - Bonos/comisiones: 100% gravados con la tarifa del periodo (Arts. 94 y 96
//   LISR).
// - Descuentos: netos post-impuestos — no tocan ISR ni IMSS.
//
// Números dorados 2026 (UMA 117.31, tarifa quincenal Anexo 8 ya verificada en
// isr.test.ts): ISR quincenal base 7,200 → 656.60; 7,800 → 763.62; 9,000 →
// 990.65; 9,600 → 1,118.81; 14,000 → 2,058.65; 18,040.35 → 2,934.45. IMSS
// obrero (SBC 600, riesgo 1): 15 días → 228.63; 13 → 198.15; 12 → 182.91.

import { describe, it, expect } from "vitest";
import type { Employee } from "@prisma/client";
import { calcularNomina } from "./calc-nomina";
import { resumirIncidencias, resumenTieneEfecto, RESUMEN_VACIO } from "./incidencias";

function empleado(salarioDiario: number): Employee & { tipoDescuentoInfonavit?: string | null } {
  return {
    salarioDiario,
    salarioDiarioIntegrado: null, // SDI = salario diario (goldens simples)
    periodicidadPago: "04", // quincenal
    riesgoPuesto: "1",
    fechaIngreso: new Date("2020-01-15"),
    tipoDescuentoInfonavit: null,
    descuentoInfonavit: null,
  } as unknown as Employee & { tipoDescuentoInfonavit?: string | null };
}

const BASE = {
  diasPagados: 15,
  tipo: "ORDINARIA" as const,
  ejercicio: 2026,
  mes: 3,
};

describe("calcularNomina + incidencias — corrida ordinaria quincenal 2026", () => {
  it("sin incidencias: línea base (sueldo 9,000, ISR 990.65, IMSS 228.63)", () => {
    const r = calcularNomina({ employee: empleado(600), ...BASE });
    expect(r.diasEfectivos).toBe(15);
    expect(r.totalPercepciones).toBe(9000);
    expect(r.isrRetenido).toBe(990.65);
    expect(r.imssObrero).toBe(228.63);
  });

  it("FALTAS: 2 faltas reducen sueldo y días de cotización IMSS", () => {
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, diasFalta: 2, numIncidencias: 1 },
    });
    expect(r.diasEfectivos).toBe(13);
    expect(r.totalPercepciones).toBe(7800); // 600 × 13
    expect(r.isrRetenido).toBe(763.62); // tarifa quincenal sobre 7,800
    expect(r.imssObrero).toBe(198.15); // cuotas de 13 días, no 15
    expect(r.netoAPagar).toBe(6838.23); // 7,800 − 763.62 − 198.15
  });

  it("INCAPACIDAD: 3 días fuera del sueldo, de la base de ISR y de IMSS", () => {
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, diasIncapacidad: 3, numIncidencias: 1 },
    });
    expect(r.diasEfectivos).toBe(12);
    expect(r.totalPercepciones).toBe(7200);
    expect(r.isrRetenido).toBe(656.6); // base 7,200 — los días de incapacidad no tributan
    expect(r.imssObrero).toBe(182.91); // 12 días de cotización
  });

  it("faltas + incapacidad nunca dejan días negativos", () => {
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, diasFalta: 10, diasIncapacidad: 10, numIncidencias: 2 },
    });
    expect(r.diasEfectivos).toBe(0);
    expect(r.totalPercepciones).toBe(0);
    expect(r.isrRetenido).toBe(0);
    expect(r.imssObrero).toBe(0);
  });

  it("HORAS EXTRA trabajador ordinario: split 50/50 y ISR sobre la parte gravada", () => {
    // 8 dobles, salario 600: pago 1,200 → exento 600, gravado 600 (dentro del
    // límite LFT y bajo el tope de 5 UMA/semana). Base ISR = 9,000 + 600.
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, horasExtraDobles: 8, numIncidencias: 1 },
    });
    const he = r.percepciones.find((p) => p.tipoPercepcion === "019");
    expect(he).toBeDefined();
    expect(he!.importeGravado).toBe(600);
    expect(he!.importeExento).toBe(600);
    expect(r.totalPercepciones).toBe(10200); // 9,000 + 1,200
    expect(r.isrRetenido).toBe(1118.81); // tarifa quincenal sobre 9,600
    expect(r.imssObrero).toBe(228.63); // las horas extra no alteran el SBC fijo
  });

  it("HORAS EXTRA trabajador de salario mínimo: 100% exentas y sin retención", () => {
    const r = calcularNomina({
      employee: empleado(315.04),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, horasExtraDobles: 6, numIncidencias: 1 },
    });
    const he = r.percepciones.find((p) => p.tipoPercepcion === "019");
    expect(he!.importeExento).toBe(472.56); // 6 × 39.38 × 2
    expect(he!.importeGravado).toBe(0);
    expect(r.isrRetenido).toBe(0); // salario mínimo: sin retención (Art. 96 LISR)
  });

  it("HORAS EXTRA triples: 100% gravadas", () => {
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, horasExtraTriples: 4, numIncidencias: 1 },
    });
    const he = r.percepciones.find((p) => p.tipoPercepcion === "019");
    expect(he!.importeGravado).toBe(900); // 4 × 75 × 3
    expect(he!.importeExento).toBe(0);
  });

  it("VACACIONES: sueldo intacto y prima vacacional con frontera de 15 UMA", () => {
    // Salario 1,200; 6 días de vacaciones → prima 1,800: exenta 1,759.65,
    // gravada 40.35. El sueldo del periodo NO cambia (los días de vacaciones
    // se pagan normal) y la cotización IMSS tampoco.
    const r = calcularNomina({
      employee: empleado(1200),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, diasVacaciones: 6, numIncidencias: 1 },
    });
    expect(r.diasEfectivos).toBe(15);
    const sueldo = r.percepciones.find((p) => p.tipoPercepcion === "001");
    expect(sueldo!.importeGravado).toBe(18000); // 1,200 × 15
    const prima = r.percepciones.find((p) => p.tipoPercepcion === "021");
    expect(prima!.importeExento).toBe(1759.65); // 15 × UMA 117.31
    expect(prima!.importeGravado).toBe(40.35);
    expect(r.isrRetenido).toBe(2934.45); // base 18,000 + 40.35
  });

  it("BONO: 100% gravado con la tarifa ordinaria del periodo", () => {
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, bonos: 5000, numIncidencias: 1 },
    });
    const bono = r.percepciones.find((p) => p.tipoPercepcion === "038");
    expect(bono!.importeGravado).toBe(5000);
    expect(bono!.importeExento).toBe(0);
    expect(r.totalPercepciones).toBe(14000);
    expect(r.isrRetenido).toBe(2058.65); // tarifa quincenal sobre 14,000
  });

  it("COMISION: percepción 028, 100% gravada", () => {
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, comisiones: 5000, numIncidencias: 1 },
    });
    const com = r.percepciones.find((p) => p.tipoPercepcion === "028");
    expect(com!.importeGravado).toBe(5000);
    expect(r.isrRetenido).toBe(2058.65); // misma base que el bono: 14,000
  });

  it("DESCUENTO: sólo mueve el neto — ISR e IMSS idénticos a la línea base", () => {
    const base = calcularNomina({ employee: empleado(600), ...BASE });
    const r = calcularNomina({
      employee: empleado(600),
      ...BASE,
      incidencias: { ...RESUMEN_VACIO, descuentos: 800, numIncidencias: 1 },
    });
    expect(r.isrRetenido).toBe(base.isrRetenido);
    expect(r.imssObrero).toBe(base.imssObrero);
    expect(r.totalPercepciones).toBe(base.totalPercepciones);
    const ded = r.deducciones.find((d) => d.tipoDeduccion === "004");
    expect(ded!.importe).toBe(800);
    expect(r.netoAPagar).toBe(Math.round((base.netoAPagar - 800) * 100) / 100);
  });

  it("las incidencias no aplican a corridas extraordinarias tipo AGUINALDO", () => {
    const r = calcularNomina({
      employee: empleado(600),
      diasPagados: 15,
      tipo: "AGUINALDO",
      ejercicio: 2026,
      mes: 12,
      fechaCorte: new Date("2026-12-31"),
      incidencias: { ...RESUMEN_VACIO, diasFalta: 5, bonos: 1000, numIncidencias: 2 },
    });
    // El aguinaldo se calcula igual con o sin incidencias.
    expect(r.percepciones.find((p) => p.tipoPercepcion === "038")).toBeUndefined();
    expect(r.diasEfectivos).toBe(15);
  });
});

describe("resumirIncidencias — mapeo de captura a insumo del motor", () => {
  it("agrega por tipo y omite las incidencias documentales", () => {
    const r = resumirIncidencias([
      { tipo: "FALTA", dias: 1, horas: null, horasTriples: null, monto: null },
      { tipo: "FALTA_JUSTIFICADA", dias: 1, horas: null, horasTriples: null, monto: null },
      { tipo: "PERMISO_SIN_GOCE", dias: 2, horas: null, horasTriples: null, monto: null },
      { tipo: "INCAPACIDAD", dias: 3, horas: null, horasTriples: null, monto: null },
      { tipo: "VACACIONES", dias: 6, horas: null, horasTriples: null, monto: null },
      { tipo: "HORAS_EXTRA", dias: 1, horas: 5, horasTriples: 2, monto: null },
      { tipo: "BONO", dias: 1, horas: null, horasTriples: null, monto: 1500 },
      { tipo: "COMISION", dias: 1, horas: null, horasTriples: null, monto: 700 },
      { tipo: "DESCUENTO", dias: 1, horas: null, horasTriples: null, monto: 300 },
      // Documentales — sin efecto monetario:
      { tipo: "PERMISO_CON_GOCE", dias: 1, horas: null, horasTriples: null, monto: null },
      { tipo: "RETARDO", dias: 1, horas: 0.5, horasTriples: null, monto: null },
    ]);
    expect(r.diasFalta).toBe(4); // FALTA + FALTA_JUSTIFICADA + PERMISO_SIN_GOCE
    expect(r.diasIncapacidad).toBe(3);
    expect(r.diasVacaciones).toBe(6);
    expect(r.horasExtraDobles).toBe(5);
    expect(r.horasExtraTriples).toBe(2);
    expect(r.bonos).toBe(1500);
    expect(r.comisiones).toBe(700);
    expect(r.descuentos).toBe(300);
    expect(r.numIncidencias).toBe(11);
  });

  it("resumenTieneEfecto distingue capturas documentales de las monetarias", () => {
    expect(resumenTieneEfecto(RESUMEN_VACIO)).toBe(false);
    expect(
      resumenTieneEfecto(
        resumirIncidencias([{ tipo: "RETARDO", dias: 1, horas: null, horasTriples: null, monto: null }])
      )
    ).toBe(false);
    expect(
      resumenTieneEfecto(
        resumirIncidencias([{ tipo: "FALTA", dias: 1, horas: null, horasTriples: null, monto: null }])
      )
    ).toBe(true);
  });
});
