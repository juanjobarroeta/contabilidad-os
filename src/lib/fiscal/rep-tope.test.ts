import { describe, expect, it } from "vitest";
import { acotarAlPadre, montosRepDelPadre, type LinkRep, type PadreRep } from "./rep-tope";

const iva = (importe: number) => ({ tipo: "IVA", retencion: false, importe });
const retIva = (importe: number) => ({ tipo: "IVA", retencion: true, importe });
const retIsr = (importe: number) => ({ tipo: "ISR", retencion: true, importe });
const rep = (impPagado: number, ivaTrasladado: number | null = null): LinkRep => ({
  impPagado,
  ivaTrasladado,
  ivaDerivado: ivaTrasladado == null,
});

describe("acotarAlPadre", () => {
  it("el mes toma lo suyo si cabe", () => {
    expect(acotarAlPadre({ tope: 1000, previo: 200, enMes: 500 })).toBe(500);
  });
  it("sólo lo que queda bajo el tope", () => {
    expect(acotarAlPadre({ tope: 1000, previo: 800, enMes: 500 })).toBe(200);
  });
  it("nada si los meses anteriores ya lo agotaron", () => {
    expect(acotarAlPadre({ tope: 1000, previo: 1300, enMes: 500 })).toBe(0);
  });
});

describe("montosRepDelPadre — los casos de CENTRO, agosto 2026", () => {
  // 8A7ED558 (BAME861218LL9): total 26,680.01, IVA 3,720.09.
  const bame: PadreRep = { total: 26_680.01, totalImpuestos: 3_720.09, taxes: [iva(3_720.09)] };

  it("los cuatro REPs (dos originales con el IVA completo + dos sustitutos) no pasan del IVA de la factura", () => {
    const m = montosRepDelPadre(bame, [], [rep(20_000.01, 3_720.09), rep(6_680, 3_720.09), rep(6_680, 931.42), rep(20_000.01, 2_788.67)]);
    expect(m.iva).toBeCloseTo(3_720.09, 2);
    expect(m.recortado).toBe(true);
  });

  it("sólo los sustitutos vigentes: 931.42 + 2,788.67 = el IVA completo, sin recorte", () => {
    const m = montosRepDelPadre(bame, [], [rep(6_680, 931.42), rep(20_000.01, 2_788.67)]);
    expect(m.iva).toBeCloseTo(3_720.09, 2);
    expect(m.recortado).toBe(false);
  });

  it("4C975443 (GCA110217729): dos REPs del mismo pago cuentan una vez", () => {
    const gca: PadreRep = { total: 7_487.8, totalImpuestos: 1_032.8, taxes: [iva(1_032.8)] };
    const m = montosRepDelPadre(gca, [], [rep(7_487.8, 1_032.8), rep(7_487.8, 1_032.8)]);
    expect(m.iva).toBeCloseTo(1_032.8, 2);
  });
});

describe("montosRepDelPadre — meses anteriores y retenciones", () => {
  const padre: PadreRep = { total: 11_600, totalImpuestos: 1_600, taxes: [iva(1_600), retIva(1_066.67), retIsr(1_000)] };

  it("lo acreditado en meses anteriores consume el tope", () => {
    const m = montosRepDelPadre(padre, [rep(11_600)], [rep(5_800)]);
    expect(m.iva).toBe(0);
    expect(m.ivaRetenido).toBe(0);
    expect(m.isrRetenido).toBe(0);
  });

  it("un pago parcial normal no se toca", () => {
    const m = montosRepDelPadre(padre, [rep(5_800)], [rep(5_800)]);
    expect(m.iva).toBeCloseTo(800, 2);
    expect(m.ivaRetenido).toBeCloseTo(533.335, 2);
    expect(m.isrRetenido).toBeCloseTo(500, 2);
    expect(m.recortado).toBe(false);
  });

  it("la retención repetida tampoco rebasa la de la factura", () => {
    const m = montosRepDelPadre(padre, [], [rep(11_600), rep(11_600)]);
    expect(m.ivaRetenido).toBeCloseTo(1_066.67, 2);
    expect(m.isrRetenido).toBeCloseTo(1_000, 2);
  });

  it("factura legada sin IVA conocido: se respeta lo que dice el REP", () => {
    const legada: PadreRep = { total: 1_000, totalImpuestos: null, taxes: [] };
    expect(montosRepDelPadre(legada, [], [rep(1_000, 137.93)]).iva).toBeCloseTo(137.93, 2);
  });
});
