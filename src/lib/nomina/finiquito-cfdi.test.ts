// ─── Pruebas del mapeo finiquito → CFDI / PayrollItem ────────────────────────
// 1) Mapeo PURO del desglose de calcularFiniquito a percepciones del CFDI de
//    separación (claves SAT 001/002/021/022/025) y a columnas de PayrollItem:
//    la suma gravado + exento de los renglones debe reproducir exactamente
//    totalBruto / totalExento / totalGravado del cálculo.
// 2) Integración con el motor: calcularNomina tipo FINIQUITO delega el
//    desglose a finiquito.ts (que NO se modifica), timbra como nómina
//    extraordinaria (TipoNomina = E) y retiene ISR con la tarifa mensual
//    (periodicidad "05") sobre la porción gravada — sin IMSS ni INFONAVIT.

import { describe, it, expect } from "vitest";
import type { Employee } from "@prisma/client";
import { percepcionesFiniquito, camposItemFiniquito } from "./finiquito-cfdi";
import { calcularFiniquito, type FiniquitoDesglose } from "./finiquito";
import { calcularNomina } from "./calc-nomina";
import { calcularIsrRetenido } from "./isr";

const r2 = (n: number) => Math.round(n * 100) / 100;

// Desglose armado a mano (liquidación por despido injustificado, salario 600,
// 6 años de antigüedad, UMA 117.31): valida el mapeo sin depender del cálculo.
const DESGLOSE_LIQUIDACION: FiniquitoDesglose = {
  salariosPendientes: 3000, // 5 días × 600
  aguinaldoProporcional: 2250,
  aguinaldoExento: 2250, // < 30 UMA (3,519.30)
  aguinaldoGravado: 0,
  vacacionesProporcionales: 4800,
  primaVacacional: 1200,
  primaVacacionalExenta: 1200, // < 15 UMA (1,759.65)
  primaVacacionalGravada: 0,
  indemnizacion3Meses: 54000, // 600 × 90
  indemnizacion20Dias: 72000, // 600 × 20 × 6
  primaAntiguedad: 16892.64, // 234.62 (2 UMA) × 12 × 6
  primaAntiguedadExenta: 10557.9, // 90 UMA
  subtotalFiniquito: 11250,
  subtotalLiquidacion: 142892.64,
  totalBruto: 154142.64,
  totalExento: 14007.9,
  totalGravado: 140134.74,
};

describe("percepcionesFiniquito — desglose → percepciones del CFDI de separación", () => {
  it("liquidación completa: un renglón por concepto con las claves SAT correctas", () => {
    const percs = percepcionesFiniquito(DESGLOSE_LIQUIDACION);
    expect(percs.map((p) => `${p.tipoPercepcion}/${p.clave}`)).toEqual([
      "001/001", // salarios pendientes
      "002/002", // aguinaldo proporcional
      "001/046", // vacaciones no disfrutadas
      "021/021", // prima vacacional
      "025/025", // indemnización Art. 50 LFT
      "022/022", // prima por antigüedad Art. 162 LFT
    ]);

    const porTipo = new Map(percs.map((p) => [`${p.tipoPercepcion}/${p.clave}`, p]));
    // Salarios y vacaciones: 100% gravados.
    expect(porTipo.get("001/001")).toMatchObject({ importeGravado: 3000, importeExento: 0 });
    expect(porTipo.get("001/046")).toMatchObject({ importeGravado: 4800, importeExento: 0 });
    // Aguinaldo y prima vacacional: exención del Art. 93 fracc. XIV ya aplicada.
    expect(porTipo.get("002/002")).toMatchObject({ importeGravado: 0, importeExento: 2250 });
    expect(porTipo.get("021/021")).toMatchObject({ importeGravado: 0, importeExento: 1200 });
    // Indemnización: 3 meses + 20 días por año, gravada (simplificación documentada).
    expect(porTipo.get("025/025")).toMatchObject({ importeGravado: 126000, importeExento: 0 });
    // Prima de antigüedad: exención de 90 UMA (Art. 93 fracc. XIII).
    expect(porTipo.get("022/022")).toMatchObject({ importeGravado: 6334.74, importeExento: 10557.9 });
  });

  it("la suma de los renglones reproduce los totales del cálculo", () => {
    const percs = percepcionesFiniquito(DESGLOSE_LIQUIDACION);
    const gravado = r2(percs.reduce((s, p) => s + p.importeGravado, 0));
    const exento = r2(percs.reduce((s, p) => s + p.importeExento, 0));
    expect(gravado).toBe(DESGLOSE_LIQUIDACION.totalGravado);
    expect(exento).toBe(DESGLOSE_LIQUIDACION.totalExento);
    expect(r2(gravado + exento)).toBe(DESGLOSE_LIQUIDACION.totalBruto);
  });

  it("finiquito voluntario sin salarios pendientes: omite los renglones en cero", () => {
    const desglose: FiniquitoDesglose = {
      ...DESGLOSE_LIQUIDACION,
      salariosPendientes: 0,
      indemnizacion3Meses: 0,
      indemnizacion20Dias: 0,
      primaAntiguedad: 0,
      primaAntiguedadExenta: 0,
      subtotalLiquidacion: 0,
      totalBruto: 8250,
      totalExento: 3450,
      totalGravado: 4800,
    };
    const percs = percepcionesFiniquito(desglose);
    expect(percs.map((p) => p.tipoPercepcion)).toEqual(["002", "001", "021"]);
    expect(percs.find((p) => p.clave === "046")?.importeGravado).toBe(4800);
  });
});

describe("camposItemFiniquito — desglose → columnas de PayrollItem", () => {
  it("mapea cada concepto a su columna; indemnización y prima de antigüedad a otrasPercepciones", () => {
    expect(camposItemFiniquito(DESGLOSE_LIQUIDACION)).toEqual({
      sueldoBase: 3000,
      aguinaldo: 2250,
      vacaciones: 4800,
      primaVacacional: 1200,
      otrasPercepciones: 142892.64, // 54,000 + 72,000 + 16,892.64
    });
  });
});

// ─── Integración: calcularNomina tipo FINIQUITO ──────────────────────────────

function empleado(salarioDiario: number): Employee & { tipoDescuentoInfonavit?: string | null } {
  return {
    salarioDiario,
    salarioDiarioIntegrado: null, // SDI = salario diario
    periodicidadPago: "04", // quincenal (el finiquito debe usar "05" mensual)
    riesgoPuesto: "1",
    fechaIngreso: new Date("2020-01-15"),
    tipoDescuentoInfonavit: null,
    descuentoInfonavit: null,
  } as unknown as Employee & { tipoDescuentoInfonavit?: string | null };
}

const BAJA = {
  motivo: "VOLUNTARIA" as const,
  fechaBaja: new Date("2026-03-31"),
  diasSalarioPendiente: 5,
};

describe("calcularNomina tipo FINIQUITO", () => {
  it("reproduce los totales de calcularFiniquito y timbra como extraordinaria", () => {
    const emp = empleado(600);
    const r = calcularNomina({
      employee: emp,
      diasPagados: 0,
      tipo: "FINIQUITO",
      ejercicio: 2026,
      mes: 3,
      finiquito: BAJA,
    });
    const fin = calcularFiniquito({
      salarioDiario: 600,
      salarioDiarioIntegrado: 600,
      fechaIngreso: emp.fechaIngreso,
      fechaBaja: BAJA.fechaBaja,
      motivo: BAJA.motivo,
      diasSalarioPendiente: BAJA.diasSalarioPendiente,
    });

    expect(r.tipoNomina).toBe("E");
    expect(r.finiquitoResult?.desglose).toEqual(fin.desglose);
    expect(r.totalPercepciones).toBe(fin.desglose.totalBruto);

    const gravado = r2(r.percepciones.reduce((s, p) => s + p.importeGravado, 0));
    const exento = r2(r.percepciones.reduce((s, p) => s + p.importeExento, 0));
    expect(gravado).toBe(fin.desglose.totalGravado);
    expect(exento).toBe(fin.desglose.totalExento);
  });

  it("retiene ISR con la tarifa mensual (periodicidad 05) sobre el gravado; sin IMSS ni INFONAVIT", () => {
    const r = calcularNomina({
      employee: empleado(600),
      diasPagados: 0,
      tipo: "FINIQUITO",
      ejercicio: 2026,
      mes: 3,
      finiquito: BAJA,
    });
    const isrEsperado = calcularIsrRetenido({
      baseGravable: r2(r.percepciones.reduce((s, p) => s + p.importeGravado, 0)),
      periodicidadPago: "05",
      ejercicio: 2026,
      mes: 3,
    }).isrRetenido;

    expect(r.isrRetenido).toBe(isrEsperado);
    expect(r.isrRetenido).toBeGreaterThan(0);
    expect(r.imssObrero).toBe(0);
    expect(r.infonavitDeduccion).toBe(0);
    expect(r.deducciones.map((d) => d.tipoDeduccion)).toEqual(["002"]); // sólo ISR
    expect(r.netoAPagar).toBe(r2(r.totalPercepciones - r.isrRetenido));
  });

  it("liquidación (INJUSTIFICADA): incluye indemnización (025) y prima de antigüedad (022)", () => {
    const r = calcularNomina({
      employee: empleado(600),
      diasPagados: 0,
      tipo: "FINIQUITO",
      ejercicio: 2026,
      mes: 3,
      finiquito: { ...BAJA, motivo: "INJUSTIFICADA" },
    });
    const tipos = r.percepciones.map((p) => p.tipoPercepcion);
    expect(tipos).toContain("025");
    expect(tipos).toContain("022");
    // La prima de antigüedad trae la exención de 90 UMA aplicada.
    const primaAnt = r.percepciones.find((p) => p.tipoPercepcion === "022")!;
    expect(primaAnt.importeExento).toBeGreaterThan(0);
  });

  it("sin datos de la baja: falla explícitamente (nunca un recibo en ceros)", () => {
    expect(() =>
      calcularNomina({ employee: empleado(600), diasPagados: 0, tipo: "FINIQUITO", ejercicio: 2026, mes: 3 })
    ).toThrow(/FINIQUITO/);
  });
});
