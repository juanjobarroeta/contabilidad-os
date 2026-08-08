import { describe, it, expect } from "vitest";
import { computeRepDoctoRelacionado, round2, type RepParentTax, sintetizarParentTaxes } from "./complementos-rep";

const IVA16: RepParentTax = { tipo: "IVA", factor: "TASA", tasa: 0.16, base: 1000, importe: 160, retencion: false };

describe("round2", () => {
  it("redondea a centavos sin el clásico error de flotante", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1000 * 0.16)).toBe(160);
    expect(round2(2.675)).toBe(2.68);
  });
});

describe("computeRepDoctoRelacionado — pago total, una parcialidad", () => {
  const r = computeRepDoctoRelacionado({
    parentTotal: 1160,
    parentSubtotal: 1000,
    priorImpPagado: 0,
    priorCount: 0,
    paymentAmount: 1160,
    parentTaxes: [IVA16],
  });

  it("liquida la factura con IVA desglosado", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docto.numParcialidad).toBe(1);
    expect(r.docto.impSaldoAnterior).toBe(1160);
    expect(r.docto.impPagado).toBe(1160);
    expect(r.docto.impSaldoInsoluto).toBe(0);
    expect(r.docto.objetoImp).toBe("02");
    expect(r.docto.traslados).toHaveLength(1);
    expect(r.docto.traslados[0]).toMatchObject({ tipo: "IVA", factor: "Tasa", base: 1000, importe: 160 });
    expect(r.docto.baseTrasladoIva).toBe(1000);
    expect(r.docto.ivaTrasladado).toBe(160);
  });
});

describe("computeRepDoctoRelacionado — parcialidades", () => {
  it("prorratea el IVA a la mitad en un pago parcial", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1160,
      parentSubtotal: 1000,
      priorImpPagado: 0,
      priorCount: 0,
      paymentAmount: 580,
      parentTaxes: [IVA16],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docto.numParcialidad).toBe(1);
    expect(r.docto.impSaldoAnterior).toBe(1160);
    expect(r.docto.impSaldoInsoluto).toBe(580);
    expect(r.docto.traslados[0]).toMatchObject({ base: 500, importe: 80 });
  });

  it("la segunda parcialidad numera y calcula el saldo anterior con lo ya pagado", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1160,
      parentSubtotal: 1000,
      priorImpPagado: 580,
      priorCount: 1,
      paymentAmount: 580,
      parentTaxes: [IVA16],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docto.numParcialidad).toBe(2);
    expect(r.docto.impSaldoAnterior).toBe(580);
    expect(r.docto.impSaldoInsoluto).toBe(0);
    expect(r.docto.traslados[0]).toMatchObject({ base: 500, importe: 80 });
  });
});

describe("computeRepDoctoRelacionado — validaciones", () => {
  it("rechaza un pago que excede el saldo pendiente", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1160, parentSubtotal: 1000, priorImpPagado: 0, priorCount: 0,
      paymentAmount: 1200, parentTaxes: [IVA16],
    });
    expect(r.ok).toBe(false);
  });

  it("acepta un pago dentro de la tolerancia de centavos", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1160, parentSubtotal: 1000, priorImpPagado: 0, priorCount: 0,
      paymentAmount: 1160.005, parentTaxes: [IVA16],
    });
    expect(r.ok).toBe(true);
  });

  it("rechaza si la factura ya está pagada por completo", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1160, parentSubtotal: 1000, priorImpPagado: 1160, priorCount: 1,
      paymentAmount: 100, parentTaxes: [IVA16],
    });
    expect(r.ok).toBe(false);
  });

  it("rechaza un pago de cero o negativo", () => {
    for (const paymentAmount of [0, -50]) {
      const r = computeRepDoctoRelacionado({
        parentTotal: 1160, parentSubtotal: 1000, priorImpPagado: 0, priorCount: 0,
        paymentAmount, parentTaxes: [IVA16],
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe("computeRepDoctoRelacionado — casos de impuestos", () => {
  it("usa el subtotal como base cuando InvoiceTax.base es null (legacy)", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1160, parentSubtotal: 1000, priorImpPagado: 0, priorCount: 0,
      paymentAmount: 1160,
      parentTaxes: [{ tipo: "IVA", factor: "TASA", tasa: 0.16, base: null, importe: 160, retencion: false }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docto.traslados[0]).toMatchObject({ base: 1000, importe: 160 });
  });

  it("separa traslados de retenciones", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1000, parentSubtotal: 1000, priorImpPagado: 0, priorCount: 0,
      paymentAmount: 1000,
      parentTaxes: [
        { tipo: "IVA", factor: "TASA", tasa: 0.16, base: 1000, importe: 160, retencion: false },
        { tipo: "ISR", factor: "TASA", tasa: 0.1, base: 1000, importe: 100, retencion: true },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docto.traslados).toHaveLength(1);
    expect(r.docto.retenciones).toHaveLength(1);
    expect(r.docto.retenciones[0]).toMatchObject({ tipo: "ISR", retencion: true });
    expect(r.docto.objetoImp).toBe("02");
  });

  it("marca objetoImp 01 y sin traslados cuando no hay impuestos", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1000, parentSubtotal: 1000, priorImpPagado: 0, priorCount: 0,
      paymentAmount: 1000, parentTaxes: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docto.objetoImp).toBe("01");
    expect(r.docto.traslados).toHaveLength(0);
    expect(r.docto.baseTrasladoIva).toBe(0);
  });

  it("ignora filas EXENTO en el desglose", () => {
    const r = computeRepDoctoRelacionado({
      parentTotal: 1000, parentSubtotal: 1000, priorImpPagado: 0, priorCount: 0,
      paymentAmount: 1000,
      parentTaxes: [{ tipo: "IVA", factor: "EXENTO", tasa: 0, base: 1000, importe: 0, retencion: false }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.docto.traslados).toHaveLength(0);
    expect(r.docto.objetoImp).toBe("01");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sintetizarParentTaxes — fallback cuando el padre no tiene filas de impuesto
// ─────────────────────────────────────────────────────────────────────────────

describe("sintetizarParentTaxes", () => {
  it("deriva IVA 16% del delta subtotal/total (caso real: 2,586.21 → 3,000.00)", () => {
    const rows = sintetizarParentTaxes(2586.21, 3000)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tipo: "IVA", factor: "TASA", tasa: 0.16, base: 2586.21, importe: 413.79 });
  });

  it("reconoce la tasa fronteriza del 8%", () => {
    const rows = sintetizarParentTaxes(1000, 1080)!;
    expect(rows[0].tasa).toBe(0.08);
  });

  it("sin delta no hay impuestos que desglosar", () => {
    expect(sintetizarParentTaxes(1000, 1000)).toEqual([]);
    expect(sintetizarParentTaxes(1000, 1000.005)).toEqual([]);
  });

  it("NO inventa cuando el delta no cuadra con una tasa conocida", () => {
    expect(sintetizarParentTaxes(1000, 1100)).toBeNull(); // 10%: mezcla o retención
    expect(sintetizarParentTaxes(1000, 900)).toBeNull(); // delta negativo (retenciones)
    expect(sintetizarParentTaxes(0, 160)).toBeNull(); // subtotal 0
  });

  it("tolera el redondeo por partida (±2 centavos)", () => {
    expect(sintetizarParentTaxes(2586.21, 3000.01)).not.toBeNull();
    expect(sintetizarParentTaxes(2586.21, 3000.05)).toBeNull();
  });
});
