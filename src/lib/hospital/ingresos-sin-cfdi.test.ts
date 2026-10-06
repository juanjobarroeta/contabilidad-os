import { describe, expect, it } from "vitest";
import { desglosarCobro, montoNoCubierto, sumarIngresosSinCfdi, tasaPonderada, type CobroSinCfdi } from "./ingresos-sin-cfdi";

// Un cobro SIN CFDI se declara igual (Art. 17 LISR, Art. 1-B LIVA): mientras
// la factura global no lo timbre, el motor suma su base a los ingresos
// nominales adicionales y su IVA al trasladado del mes.

const cobro = (extra: Partial<CobroSinCfdi> = {}): CobroSinCfdi => ({
  id: "c1",
  monto: 1160,
  facturaVigente: false,
  cargosGlobal: [],
  cargosEpisodio: [{ importe: 1000, ivaTasa: 0.16 }],
  ...extra,
});

describe("tasaPonderada()", () => {
  it("pondera por importe los cargos con tasa", () => {
    expect(tasaPonderada([{ importe: 1000, ivaTasa: 0.16 }, { importe: 1000, ivaTasa: 0 }])).toBeCloseTo(0.08);
  });
  it("sin cargos con tasa no inventa una", () => {
    expect(tasaPonderada([{ importe: 500, ivaTasa: null }])).toBeNull();
    expect(tasaPonderada([])).toBeNull();
  });
});

describe("desglosarCobro()", () => {
  it("el cobro trae el IVA dentro", () => {
    expect(desglosarCobro(1160, 0.16)).toEqual({ base: 1000, iva: 160 });
    expect(desglosarCobro(500, 0)).toEqual({ base: 500, iva: 0 });
  });
});

describe("montoNoCubierto()", () => {
  it("con factura vigente ya está en los CFDIs del mes", () => {
    expect(montoNoCubierto(cobro({ facturaVigente: true }))).toBe(0);
  });
  it("sin cargos en la global, todo sigue sin CFDI", () => {
    expect(montoNoCubierto(cobro())).toBe(1160);
  });
  it("la global timbrada cubre en proporción a sus cargos", () => {
    const c = cobro({ cargosGlobal: [{ importe: 600, timbrado: true }, { importe: 400, timbrado: false }] });
    expect(montoNoCubierto(c)).toBe(464);
    expect(montoNoCubierto(cobro({ cargosGlobal: [{ importe: 1000, timbrado: true }] }))).toBe(0);
  });
});

describe("sumarIngresosSinCfdi()", () => {
  it("suma base e IVA de lo no cubierto; la tasa sale de los cargos", () => {
    const r = sumarIngresosSinCfdi([cobro(), cobro({ id: "c2", facturaVigente: true })], null);
    expect(r).toMatchObject({ base: 1000, iva: 160, cobros: 1 });
  });
  it("sin tasa en los cargos usa la de HospConfig; sin ella, 0", () => {
    const sinTasa = cobro({ cargosEpisodio: [{ importe: 1000, ivaTasa: null }] });
    expect(sumarIngresosSinCfdi([sinTasa], 0.16)).toMatchObject({ base: 1000, iva: 160 });
    expect(sumarIngresosSinCfdi([sinTasa], null)).toMatchObject({ base: 1160, iva: 0 });
  });
});
