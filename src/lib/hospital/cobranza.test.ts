import { describe, it, expect } from "vitest";
import { acumularAging, agingVacio, bucketAging, conciliadoDe, diasDesde, pagadoPorEvidencia, sumarAging } from "./cobranza";

const hoy = new Date(2026, 8, 3); // 3-sep-2026
const hace = (dias: number) => new Date(hoy.getTime() - dias * 86_400_000);

describe("antigüedad", () => {
  it("cuenta días calendario sin horas", () => {
    expect(diasDesde(hace(0), hoy)).toBe(0);
    expect(diasDesde(new Date(2026, 8, 2, 23, 59), new Date(2026, 8, 3, 0, 1))).toBe(1);
    expect(diasDesde(hace(45), hoy)).toBe(45);
  });
  it("corta en 30 / 60 / 90 inclusive", () => {
    expect(bucketAging(hace(0), hoy)).toBe("0-30");
    expect(bucketAging(hace(30), hoy)).toBe("0-30");
    expect(bucketAging(hace(31), hoy)).toBe("31-60");
    expect(bucketAging(hace(60), hoy)).toBe("31-60");
    expect(bucketAging(hace(61), hoy)).toBe("61-90");
    expect(bucketAging(hace(90), hoy)).toBe("61-90");
    expect(bucketAging(hace(91), hoy)).toBe("90+");
    expect(bucketAging(hace(400), hoy)).toBe("90+");
  });
  it("suma y acumula por corte", () => {
    const a = sumarAging(sumarAging(agingVacio(), "0-30", 100.005), "90+", 50);
    expect(a).toEqual({ "0-30": 100.01, "31-60": 0, "61-90": 0, "90+": 50 });
    expect(acumularAging(a, { "0-30": 1, "31-60": 2, "61-90": 3, "90+": 4 })).toEqual({ "0-30": 101.01, "31-60": 2, "61-90": 3, "90+": 54 });
  });
});

describe("pagadoPorEvidencia()", () => {
  it("PUE queda pagada en su emisión", () => {
    expect(pagadoPorEvidencia({ metodoPago: "PUE", total: 1000, conciliado: 0, amparadoRep: 0 })).toEqual({ pagado: 1000, saldo: 0, repPendiente: 0 });
  });
  it("PPD toma la mejor evidencia (REP o banco) y señala el REP faltante", () => {
    expect(pagadoPorEvidencia({ metodoPago: "PPD", total: 1000, conciliado: 300, amparadoRep: 600 })).toEqual({ pagado: 600, saldo: 400, repPendiente: 0 });
    expect(pagadoPorEvidencia({ metodoPago: "PPD", total: 1000, conciliado: 800, amparadoRep: 600 })).toEqual({ pagado: 800, saldo: 200, repPendiente: 200 });
    expect(pagadoPorEvidencia({ metodoPago: "PPD", total: 1000, conciliado: 0, amparadoRep: 0 })).toEqual({ pagado: 0, saldo: 1000, repPendiente: 0 });
  });
  it("el saldo nunca es negativo aunque sobre evidencia", () => {
    expect(pagadoPorEvidencia({ metodoPago: "PPD", total: 1000, conciliado: 1200, amparadoRep: 0 }).saldo).toBe(0);
  });
});

describe("conciliadoDe()", () => {
  it("suma en valor absoluto (los pagos a proveedor vienen negativos)", () => {
    expect(conciliadoDe([{ montoAsignado: -300 }, { montoAsignado: 200.004 }])).toBe(500);
  });
});
