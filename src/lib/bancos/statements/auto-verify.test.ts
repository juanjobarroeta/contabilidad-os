import { describe, expect, it } from "vitest";
import { mesDelDocumento, operacionAutomatica } from "./auto-verify";

describe("mesDelDocumento", () => {
  it("usa el inicio impreso y si no, el periodo", () => {
    expect(mesDelDocumento({ periodStart: "2025-03-01", periodo: "2025-04" })).toEqual({ year: 2025, month: 3 });
    expect(mesDelDocumento({ periodStart: null, periodo: "2025-04" })).toEqual({ year: 2025, month: 4 });
    expect(mesDelDocumento({ periodStart: null, periodo: null })).toBeNull();
  });
});

describe("operacionAutomatica", () => {
  const doc = { id: "b", periodo: "2025-03", periodStart: "2025-03-01", saldoInicial: "1000", saldoFinal: "1379.5", controls: { credits: 500, debits: 120.5, creditCount: 1, debitCount: 1 } };
  it("arma la verificación del mes completo con los valores leídos", () => {
    const { op } = operacionAutomatica(doc, 2025, 3);
    expect(op).toMatchObject({ type: "verify", opening: 1000, closing: 1379.5, credits: 500, debits: 120.5, creditCount: 1, debitCount: 1,
      countsUnavailable: false, periodStart: "2025-03-01", periodEnd: "2025-03-31" });
  });
  it("sin conteos impresos marca countsUnavailable", () => {
    const { op } = operacionAutomatica({ ...doc, controls: { credits: 500, debits: 120.5, creditCount: null, debitCount: null } }, 2025, 3);
    expect(op).toMatchObject({ countsUnavailable: true, creditCount: null, debitCount: null });
  });
  it("sin saldos o sin totales no hay operación, hay motivos", () => {
    expect(operacionAutomatica({ ...doc, saldoFinal: null }, 2025, 3).motivos[0]).toMatch(/saldos/);
    expect(operacionAutomatica({ ...doc, controls: null }, 2025, 3).motivos[0]).toMatch(/totales/);
  });
});
