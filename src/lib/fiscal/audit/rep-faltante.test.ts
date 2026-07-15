import { describe, it, expect } from "vitest";
import { auditarCobrosSinRep, type CobroSinRep } from "./rep-faltante";

const cobro = (over: Partial<CobroSinRep> = {}): CobroSinRep => ({
  invoiceId: "inv1",
  folio: "B1850",
  cobradoBanco: 45_860,
  amparadoRep: 0,
  sinRep: 45_860,
  ivaEstimado: 7_337.6,
  ...over,
});

describe("auditarCobrosSinRep", () => {
  it("sin cobros pendientes no emite hallazgo", () => {
    expect(auditarCobrosSinRep([])).toEqual([]);
  });

  it("agrega N cobros en UN hallazgo con dedupeRef estable y suma montos e IVA", () => {
    // Caso real: $45,860 cobrados de facturas de meses anteriores sin REP →
    // ~$7,337.60 de IVA trasladado que el contador sí contaba y el motor no.
    const out = auditarCobrosSinRep([
      cobro(),
      cobro({ invoiceId: "inv2", folio: "B1859", cobradoBanco: 4_043.64, sinRep: 4_043.64, ivaEstimado: 557.74 }),
    ]);
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.checkClave).toBe("cfdi.rep.faltante_cobro");
    expect(h.dedupeRef).toBe("cfdi.rep.faltante_cobro");
    expect(h.severidad).toBe("warn");
    expect(h.referencias).toEqual(["inv1", "inv2"]);
    expect(h.mensaje).toContain("2 factura(s)");
    expect(h.mensaje).toContain("$49,903.64");
    expect(h.mensaje).toContain("$7,895.34");
    expect(h.fundamento).toEqual({ ley: "LIVA", articulo: "1-B" });
  });

  it("un cobro parcialmente amparado reporta sólo la porción sin REP", () => {
    const out = auditarCobrosSinRep([
      cobro({ cobradoBanco: 10_000, amparadoRep: 6_000, sinRep: 4_000, ivaEstimado: 551.72 }),
    ]);
    expect(out[0].mensaje).toContain("$4,000.00");
  });
});
