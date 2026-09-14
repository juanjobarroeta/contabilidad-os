import { describe, expect, it } from "vitest";
import { aplicarFlujoPue } from "./iva-pue-flujo";

const f = { total: 11600, ivaNeto: 1600 };

describe("aplicarFlujoPue — Art. 5-I en flujo", () => {
  it("empresa sin conciliación: se supone pagado al emitirse (comportamiento de siempre)", () => {
    expect(aplicarFlujoPue(f, null, "SUPUESTO_PAGADO")).toEqual({ acreditable: 1600, fraccion: 1, estado: "SUPUESTO" });
  });
  it("sin pago en el periodo: no se acredita nada", () => {
    expect(aplicarFlujoPue(f, null, "FLUJO")).toEqual({ acreditable: 0, fraccion: 0, estado: "SIN_PAGO" });
    expect(aplicarFlujoPue(f, { pagadoEnPeriodo: 0, pagadoAcumulado: 11600 }, "FLUJO").estado).toBe("SIN_PAGO");
  });
  it("pagada completa en el periodo: todo el IVA (con holgura de centavos)", () => {
    expect(aplicarFlujoPue(f, { pagadoEnPeriodo: 11600, pagadoAcumulado: 11600 }, "FLUJO")).toEqual({ acreditable: 1600, fraccion: 1, estado: "PAGADA" });
    expect(aplicarFlujoPue(f, { pagadoEnPeriodo: 11599.6, pagadoAcumulado: 11599.6 }, "FLUJO").estado).toBe("PAGADA");
  });
  it("pago parcial: IVA prorrateado por lo pagado ÷ total", () => {
    const r = aplicarFlujoPue(f, { pagadoEnPeriodo: 5800, pagadoAcumulado: 5800 }, "FLUJO");
    expect(r.estado).toBe("PARCIAL");
    expect(r.fraccion).toBeCloseTo(0.5, 6);
    expect(r.acreditable).toBe(800);
  });
  it("un pago de más no acredita más IVA del que trae la factura", () => {
    expect(aplicarFlujoPue(f, { pagadoEnPeriodo: 12000, pagadoAcumulado: 12000 }, "FLUJO").acreditable).toBe(1600);
  });
  it("la retención ya viene descontada en ivaNeto y el prorrateo la respeta", () => {
    // Honorarios: IVA 1600, retenido 2/3 → neto 533.33; pagado la mitad.
    const r = aplicarFlujoPue({ total: 10533.33, ivaNeto: 533.33 }, { pagadoEnPeriodo: 5266.67, pagadoAcumulado: 5266.67 }, "FLUJO");
    expect(r.acreditable).toBeCloseTo(266.67, 1);
  });
  it("factura sin total: nada que prorratear", () => {
    expect(aplicarFlujoPue({ total: 0, ivaNeto: 100 }, { pagadoEnPeriodo: 50, pagadoAcumulado: 50 }, "FLUJO").acreditable).toBe(0);
  });
});
