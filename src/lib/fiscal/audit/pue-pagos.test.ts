import { describe, it, expect } from "vitest";
import { auditarPagosPue } from "./pue-pagos";

describe("auditarPagosPue", () => {
  it("no emite hallazgo cuando no hay PUE sin pago", () => {
    expect(auditarPagosPue([], 2026)).toEqual([]);
  });

  it("emite un único hallazgo agregado con el IVA total y todas las referencias", () => {
    const out = auditarPagosPue(
      [
        { invoiceId: "a", total: 1160, ivaAcreditable: 160 },
        { invoiceId: "b", total: 2320, ivaAcreditable: 320 },
      ],
      2026
    );
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.checkClave).toBe("iva.pue.sin_pago");
    expect(h.severidad).toBe("warn");
    expect(h.referencias).toEqual(["a", "b"]);
    expect(h.fundamento).toEqual({ ley: "LIVA", articulo: "5", fraccion: "I" });
    // 160 + 320 = 480 de IVA, formateado en el mensaje.
    expect(h.mensaje).toContain("480.00");
    expect(h.mensaje).toContain("2 CFDI");
    expect(h.mensaje).toContain("2026");
  });
});
