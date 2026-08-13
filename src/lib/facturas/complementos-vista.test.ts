import { describe, expect, it } from "vitest";
import { direccionRep, estadoRepFactura, resumenRep } from "./complementos-vista";

describe("direccionRep", () => {
  it("un REP que paga una factura NUESTRA es emitido", () => {
    expect(direccionRep(["INGRESO"])).toBe("emitido");
  });

  it("un REP que paga una factura de un proveedor es recibido", () => {
    expect(direccionRep(["EGRESO"])).toBe("recibido");
  });

  it("sin facturas relacionadas en el sistema no se inventa dirección", () => {
    // Peor un dato inventado que un "sin clasificar" honesto.
    expect(direccionRep([])).toBeNull();
  });

  it("varios doctos del mismo lado no cambian el veredicto", () => {
    expect(direccionRep(["INGRESO", "INGRESO"])).toBe("emitido");
  });
});

describe("estadoRepFactura", () => {
  it("sin complementos y con saldo: el botón original", () => {
    const e = estadoRepFactura(5_000, 0);
    expect(e.emitible).toBe(true);
    expect(e.etiqueta).toBe("Emitir complemento de pago (REP)");
    expect(e.nota).toBeNull();
  });

  it("pagada por completo NO invita a emitir otro — el bug reportado", () => {
    // El detalle decía "Emitir complemento de pago" aunque ya estuviera
    // emitido y la factura saldada: invitaba a duplicar el REP.
    const e = estadoRepFactura(0, 1);
    expect(e.emitible).toBe(false);
    expect(e.nota).toMatch(/Pagada por completo — 1 complemento emitido/);
  });

  it("con parcialidad previa y saldo: 'emitir otro', con el saldo visible", () => {
    const e = estadoRepFactura(12_500.5, 2);
    expect(e.emitible).toBe(true);
    expect(e.etiqueta).toMatch(/Emitir otro complemento/);
    expect(e.etiqueta).toMatch(/12,500\.50/);
    expect(e.nota).toMatch(/2 complementos emitidos/);
  });

  it("el residuo de centavo cuenta como pagada", () => {
    expect(estadoRepFactura(0.009, 3).emitible).toBe(false);
    expect(estadoRepFactura(0.02, 3).emitible).toBe(true);
  });

  it("pluraliza bien el singular", () => {
    expect(estadoRepFactura(0, 1).nota).not.toMatch(/complementos/);
    expect(estadoRepFactura(0, 2).nota).toMatch(/complementos/);
  });
});

describe("resumenRep", () => {
  it("suma montos e IVA de los doctos (el comprobante trae $0)", () => {
    const r = resumenRep([
      { impPagado: 1_000, ivaTrasladado: 160, fechaPago: "2026-07-01", numParcialidad: 1 },
      { impPagado: 500, ivaTrasladado: 80, fechaPago: "2026-07-03", numParcialidad: 2 },
    ]);
    expect(r.monto).toBe(1_500);
    expect(r.iva).toBe(240);
  });

  it("la fecha de pago es la MÁS TEMPRANA — la que causa el IVA", () => {
    const r = resumenRep([
      { impPagado: 1, ivaTrasladado: 0, fechaPago: "2026-07-15", numParcialidad: null },
      { impPagado: 1, ivaTrasladado: 0, fechaPago: "2026-07-02", numParcialidad: null },
    ]);
    expect(r.fechaPago).toBe("2026-07-02");
  });

  it("acepta Date y string, y tolera nulls", () => {
    const r = resumenRep([
      { impPagado: null, ivaTrasladado: null, fechaPago: new Date("2026-07-01T00:00:00Z"), numParcialidad: null },
    ]);
    expect(r.monto).toBe(0);
    expect(r.fechaPago).toMatch(/^2026-07-01/);
  });

  it("las parcialidades salen únicas y ordenadas", () => {
    const r = resumenRep([
      { impPagado: 1, ivaTrasladado: 0, fechaPago: null, numParcialidad: 3 },
      { impPagado: 1, ivaTrasladado: 0, fechaPago: null, numParcialidad: 1 },
      { impPagado: 1, ivaTrasladado: 0, fechaPago: null, numParcialidad: 3 },
    ]);
    expect(r.parcialidades).toEqual([1, 3]);
  });

  it("sin doctos devuelve ceros, no NaN", () => {
    const r = resumenRep([]);
    expect(r.monto).toBe(0);
    expect(r.fechaPago).toBeNull();
  });
});
