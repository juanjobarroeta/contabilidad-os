import { describe, it, expect } from "vitest";
import {
  acumuladosEmpleado,
  aniosConRecibos,
  anioDePago,
  type ReciboAcumulable,
} from "./acumulados";

// Recibo base: todo en cero, se sobreescribe por caso.
function recibo(overrides: Partial<ReciboAcumulable>): ReciboAcumulable {
  return {
    fechaPago: "2025-01-15T00:00:00.000Z",
    origen: "APP",
    sueldoBase: 0,
    horasExtra: 0,
    bonosPagoFijo: 0,
    bonosPagoVar: 0,
    vales: 0,
    otrasPercepciones: 0,
    aguinaldo: 0,
    primaVacacional: 0,
    vacaciones: 0,
    ptu: 0,
    isrRetenido: 0,
    imssObrero: 0,
    infonavit: 0,
    otrasDeducc: 0,
    totalPercepciones: 0,
    totalDeducciones: 0,
    netoAPagar: 0,
    ...overrides,
  };
}

describe("anioDePago", () => {
  it("usa el año UTC (no el local) de la fecha de pago", () => {
    expect(anioDePago("2024-12-31T23:59:59.000Z")).toBe(2024);
    expect(anioDePago("2025-01-01T00:00:00.000Z")).toBe(2025);
    expect(anioDePago(new Date(Date.UTC(2023, 0, 1)))).toBe(2023);
  });
});

describe("acumuladosEmpleado", () => {
  it("caso dorado: quincenas mixtas APP + SAT del mismo ejercicio", () => {
    // Dos quincenas importadas del SAT y una nativa, ejercicio 2025.
    const items: ReciboAcumulable[] = [
      recibo({
        fechaPago: "2025-01-15T00:00:00.000Z",
        origen: "SAT",
        sueldoBase: 7500,
        vales: 800,
        otrasPercepciones: 200,
        isrRetenido: 743.21,
        imssObrero: 187.5,
        totalPercepciones: 8500,
        totalDeducciones: 930.71,
        netoAPagar: 7569.29,
      }),
      recibo({
        fechaPago: "2025-01-31T00:00:00.000Z",
        origen: "SAT",
        sueldoBase: 7500,
        horasExtra: 450.55,
        isrRetenido: 801.02,
        imssObrero: 187.5,
        infonavit: 320,
        totalPercepciones: 7950.55,
        totalDeducciones: 1308.52,
        netoAPagar: 6642.03,
      }),
      recibo({
        fechaPago: "2025-02-15T00:00:00.000Z",
        origen: "APP",
        sueldoBase: 7500,
        bonosPagoFijo: 500,
        bonosPagoVar: 250,
        isrRetenido: 812.77,
        imssObrero: 187.5,
        otrasDeducc: 100,
        totalPercepciones: 8250,
        totalDeducciones: 1100.27,
        netoAPagar: 7149.73,
      }),
    ];

    const acc = acumuladosEmpleado(items, 2025);
    expect(acc.anio).toBe(2025);
    expect(acc.recibos).toBe(3);
    expect(acc.porOrigen).toEqual({ app: 1, sat: 2 });

    expect(acc.percepciones.sueldo).toBe(22500);
    expect(acc.percepciones.horasExtra).toBe(450.55);
    expect(acc.percepciones.bonosFijos).toBe(500);
    expect(acc.percepciones.bonosVariables).toBe(250);
    expect(acc.percepciones.vales).toBe(800);
    expect(acc.percepciones.otras).toBe(200);
    expect(acc.percepciones.total).toBe(24700.55);

    expect(acc.deducciones.isrRetenido).toBe(2357);
    expect(acc.deducciones.imssObrero).toBe(562.5);
    expect(acc.deducciones.infonavit).toBe(320);
    expect(acc.deducciones.otras).toBe(100);
    expect(acc.deducciones.total).toBe(3339.5);

    expect(acc.netoPagado).toBe(21361.05);
    // Consistencia interna del caso: percepciones − deducciones = neto.
    expect(acc.percepciones.total - acc.deducciones.total).toBeCloseTo(acc.netoPagado, 2);
  });

  it("filtra por ejercicio: sólo suma los recibos del año pedido (frontera UTC)", () => {
    const items: ReciboAcumulable[] = [
      // Último recibo de 2024 — NO debe entrar en 2025.
      recibo({
        fechaPago: "2024-12-31T23:59:59.000Z",
        sueldoBase: 5000,
        isrRetenido: 400,
        totalPercepciones: 5000,
        totalDeducciones: 400,
        netoAPagar: 4600,
      }),
      // Primer recibo de 2025 — SÍ entra.
      recibo({
        fechaPago: "2025-01-01T00:00:00.000Z",
        sueldoBase: 5000,
        isrRetenido: 410,
        totalPercepciones: 5000,
        totalDeducciones: 410,
        netoAPagar: 4590,
      }),
      // Aguinaldo 2025.
      recibo({
        fechaPago: "2025-12-18T00:00:00.000Z",
        origen: "SAT",
        aguinaldo: 2500,
        isrRetenido: 120,
        totalPercepciones: 2500,
        totalDeducciones: 120,
        netoAPagar: 2380,
      }),
    ];

    const acc2025 = acumuladosEmpleado(items, 2025);
    expect(acc2025.recibos).toBe(2);
    expect(acc2025.percepciones.sueldo).toBe(5000);
    expect(acc2025.percepciones.aguinaldo).toBe(2500);
    expect(acc2025.deducciones.isrRetenido).toBe(530);
    expect(acc2025.netoPagado).toBe(6970);

    const acc2024 = acumuladosEmpleado(items, 2024);
    expect(acc2024.recibos).toBe(1);
    expect(acc2024.netoPagado).toBe(4600);

    // Sin año: acumula todo el historial y lo marca con anio null.
    const total = acumuladosEmpleado(items);
    expect(total.anio).toBeNull();
    expect(total.recibos).toBe(3);
    expect(total.netoPagado).toBe(4600 + 4590 + 2380);
  });

  it("historial vacío: ceros bien formados (no NaN) con el año pedido", () => {
    const acc = acumuladosEmpleado([], 2025);
    expect(acc.anio).toBe(2025);
    expect(acc.recibos).toBe(0);
    expect(acc.porOrigen).toEqual({ app: 0, sat: 0 });
    expect(acc.percepciones.total).toBe(0);
    expect(acc.deducciones.total).toBe(0);
    expect(acc.netoPagado).toBe(0);
  });

  it("año sin recibos dentro de un historial no vacío: ceros", () => {
    const items = [recibo({ fechaPago: "2023-06-15T00:00:00.000Z", netoAPagar: 100, totalPercepciones: 100 })];
    const acc = acumuladosEmpleado(items, 2025);
    expect(acc.recibos).toBe(0);
    expect(acc.netoPagado).toBe(0);
  });

  it("redondea a centavos (sin ruido binario de floats)", () => {
    const items = [
      recibo({ fechaPago: "2025-03-15T00:00:00.000Z", isrRetenido: 0.1, totalDeducciones: 0.1 }),
      recibo({ fechaPago: "2025-03-31T00:00:00.000Z", isrRetenido: 0.2, totalDeducciones: 0.2 }),
    ];
    const acc = acumuladosEmpleado(items, 2025);
    expect(acc.deducciones.isrRetenido).toBe(0.3);
    expect(acc.deducciones.total).toBe(0.3);
  });

  it("origen ausente o desconocido cuenta como APP (nativo)", () => {
    const items = [
      recibo({ fechaPago: "2025-01-15T00:00:00.000Z", origen: null }),
      recibo({ fechaPago: "2025-01-31T00:00:00.000Z", origen: undefined }),
      recibo({ fechaPago: "2025-02-15T00:00:00.000Z", origen: "SAT" }),
    ];
    const acc = acumuladosEmpleado(items, 2025);
    expect(acc.porOrigen).toEqual({ app: 2, sat: 1 });
  });

  it("acepta fechaPago como Date además de string ISO", () => {
    const items = [
      recibo({ fechaPago: new Date(Date.UTC(2025, 4, 15)), netoAPagar: 1234.56, totalPercepciones: 1234.56 }),
    ];
    const acc = acumuladosEmpleado(items, 2025);
    expect(acc.recibos).toBe(1);
    expect(acc.netoPagado).toBe(1234.56);
  });
});

describe("aniosConRecibos", () => {
  it("devuelve los ejercicios únicos, del más reciente al más antiguo", () => {
    const items = [
      { fechaPago: "2023-01-15T00:00:00.000Z" },
      { fechaPago: "2025-01-15T00:00:00.000Z" },
      { fechaPago: "2023-12-15T00:00:00.000Z" },
      { fechaPago: "2024-07-15T00:00:00.000Z" },
    ];
    expect(aniosConRecibos(items)).toEqual([2025, 2024, 2023]);
  });

  it("historial vacío → lista vacía", () => {
    expect(aniosConRecibos([])).toEqual([]);
  });
});
