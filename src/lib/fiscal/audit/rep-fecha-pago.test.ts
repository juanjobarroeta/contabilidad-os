import { describe, it, expect } from "vitest";
import { auditarRepFechaPagoAnterior, type RepFechaAnterior } from "./rep-fecha-pago";

describe("auditarRepFechaPagoAnterior", () => {
  it("con un solo par emite un hallazgo con el detalle del REP y la factura", () => {
    const items: RepFechaAnterior[] = [
      { repId: "rep1", repLabel: "P1", parentId: "f878", parentLabel: "A878", fechaPago: "2026-05-20", facturaFecha: "2026-06-11" },
    ];
    const hallazgos = auditarRepFechaPagoAnterior(items);
    expect(hallazgos).toHaveLength(1);
    const h = hallazgos[0];
    expect(h.checkClave).toBe("cfdi.rep.fecha_pago_anterior_factura");
    expect(h.severidad).toBe("warn");
    expect(h.referencias).toEqual(["rep1", "f878"]);
    expect(h.dedupeRef).toBe("cfdi.rep.fecha_pago_anterior_factura");
    expect(h.mensaje).toContain("A878");
    expect(h.mensaje).toContain("2026-05-20");
    expect(h.mensaje).toContain("2026-06-11");
    expect(h.fundamento.ley).toBe("CFF");
  });

  it("agrega muchos pares en UN solo hallazgo con dedupeRef estable", () => {
    const items: RepFechaAnterior[] = Array.from({ length: 1422 }, (_, k) => ({
      repId: `rep${k}`,
      repLabel: `P${k}`,
      parentId: `f${k}`,
      parentLabel: `A${k}`,
      fechaPago: "2026-05-20",
      facturaFecha: "2026-06-11",
    }));
    const hallazgos = auditarRepFechaPagoAnterior(items);
    // Un único hallazgo, no 1422.
    expect(hallazgos).toHaveLength(1);
    const h = hallazgos[0];
    expect(h.dedupeRef).toBe("cfdi.rep.fecha_pago_anterior_factura");
    // Todos los CFDIs (REP + factura) quedan en referencias.
    expect(h.referencias).toHaveLength(1422 * 2);
    expect(h.referencias).toContain("rep0");
    expect(h.referencias).toContain("f1421");
    expect(h.mensaje).toContain("1422");
  });

  it("sin items no emite hallazgos", () => {
    expect(auditarRepFechaPagoAnterior([])).toHaveLength(0);
  });
});
