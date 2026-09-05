import { describe, expect, it } from "vitest";
import { ivaAcreditableNetoDe, ivaRetenidoDe, repIvaRetenidoDe, revisarRetencionIva } from "./iva-retenciones";

const honorarios = {
  // Honorarios PF: base 10,000; IVA 1,600 trasladado; retención 2/3 = 1,066.67
  taxes: [
    { tipo: "IVA", retencion: false, importe: 1600 },
    { tipo: "IVA", retencion: true, importe: 1066.67 },
    { tipo: "ISR", retencion: true, importe: 1000 },
  ],
  totalImpuestos: 1600,
  total: 9533.33,
};

describe("ivaRetenidoDe / ivaAcreditableNetoDe (Art. 5-IV LIVA)", () => {
  it("suma sólo las retenciones de IVA, no las de ISR", () => {
    expect(ivaRetenidoDe(honorarios)).toBeCloseTo(1066.67, 2);
  });

  it("el acreditable del mes de la operación excluye lo retenido", () => {
    expect(ivaAcreditableNetoDe(honorarios)).toBeCloseTo(533.33, 2);
  });

  it("sin retención el acreditable es el trasladado completo", () => {
    const inv = { taxes: [{ tipo: "IVA", retencion: false, importe: 160 }], totalImpuestos: 160 };
    expect(ivaAcreditableNetoDe(inv)).toBe(160);
  });

  it("una retención mayor al trasladado no produce acreditable negativo", () => {
    const inv = { taxes: [{ tipo: "IVA", retencion: false, importe: 0 }, { tipo: "IVA", retencion: true, importe: 0.01 }], totalImpuestos: 0 };
    expect(ivaAcreditableNetoDe(inv)).toBe(0);
  });
});

describe("repIvaRetenidoDe — PPD prorrateado por pago", () => {
  it("prorratea la retención por lo pagado en el REP", () => {
    // Se pagó la mitad → la mitad de la retención se retiene/entera este mes.
    expect(repIvaRetenidoDe({ impPagado: 4766.665 }, honorarios)).toBeCloseTo(533.33, 2);
  });
  it("no excede la retención total aunque el pago exceda el total", () => {
    expect(repIvaRetenidoDe({ impPagado: 20000 }, honorarios)).toBeCloseTo(1066.67, 2);
  });
  it("cero sin pago, sin retención o sin total", () => {
    expect(repIvaRetenidoDe({ impPagado: null }, honorarios)).toBe(0);
    expect(repIvaRetenidoDe({ impPagado: 100 }, { ...honorarios, taxes: [] })).toBe(0);
    expect(repIvaRetenidoDe({ impPagado: 100 }, { ...honorarios, total: 0 })).toBe(0);
  });
});

describe("revisarRetencionIva", () => {
  it("acepta las retenciones usuales: 2/3 del IVA y 4% de autotransporte", () => {
    expect(revisarRetencionIva({ subtotal: 10000, trasladado: 1600, retenido: 1066.67 })).toEqual({ revisar: false });
    expect(revisarRetencionIva({ subtotal: 10000, trasladado: 1600, retenido: 400 })).toEqual({ revisar: false });
  });
  it("acepta la retención del 100% del IVA (desperdicios)", () => {
    expect(revisarRetencionIva({ subtotal: 10000, trasladado: 1600, retenido: 1600 })).toEqual({ revisar: false });
  });
  it("marca el caso real: comisión bancaria de $0.01 con $0.01 retenido y $0.00 trasladado", () => {
    const r = revisarRetencionIva({ subtotal: 0.01, trasladado: 0, retenido: 0.01 });
    expect(r.revisar).toBe(true);
    if (r.revisar) expect(r.motivo).toMatch(/supera el IVA trasladado/);
  });
  it("marca una retención mayor al 16% de la base aunque haya trasladado suficiente", () => {
    const r = revisarRetencionIva({ subtotal: 100, trasladado: 50, retenido: 40 });
    expect(r.revisar).toBe(true);
    if (r.revisar) expect(r.motivo).toMatch(/16%/);
  });
  it("sin retención no hay nada que revisar", () => {
    expect(revisarRetencionIva({ subtotal: 100, trasladado: 16, retenido: 0 })).toEqual({ revisar: false });
  });
});
