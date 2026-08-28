import { describe, it, expect } from "vitest";
import { auditarDuplicados, type GrupoDuplicado } from "./duplicados";

describe("auditarDuplicados", () => {
  it("un grupo: mensaje específico, referenciando todos los CFDIs", () => {
    const grupos: GrupoDuplicado[] = [
      { ids: ["a878", "a879"], direccion: "INGRESO", contraparte: "BULDING INNOVATIVE IDEAS", total: 20106.18, fecha: "2026-06-11" },
    ];
    const h = auditarDuplicados(grupos);
    expect(h).toHaveLength(1);
    expect(h[0].checkClave).toBe("cfdi.posible_duplicado");
    expect(h[0].severidad).toBe("warn");
    expect(h[0].referencias).toEqual(["a878", "a879"]);
    expect(h[0].mensaje).toContain("2");
    expect(h[0].mensaje).toContain("BULDING INNOVATIVE IDEAS");
    expect(h[0].dedupeRef).toBe("cfdi.posible_duplicado");
  });

  it("varios grupos: UN caso por empresa con conteo, monto y muestra", () => {
    const grupos: GrupoDuplicado[] = [
      { ids: ["a1", "a2"], direccion: "INGRESO", contraparte: "CLIENTE UNO", total: 1000, fecha: "2026-06-11" },
      { ids: ["b1", "b2", "b3"], direccion: "EGRESO", contraparte: "PROVEEDOR DOS", total: 500, fecha: "2026-06-12" },
    ];
    const h = auditarDuplicados(grupos);
    expect(h).toHaveLength(1);
    expect(h[0].dedupeRef).toBe("cfdi.posible_duplicado");
    expect(h[0].referencias).toEqual(["a1", "a2", "b1", "b2", "b3"]);
    expect(h[0].mensaje).toContain("5 CFDIs");
    expect(h[0].mensaje).toContain("2 grupos");
    expect(h[0].mensaje).toContain("1 de ingreso y 1 de egreso");
    expect(h[0].mensaje).toContain("$1,500.00");
    expect(h[0].mensaje).toContain("CLIENTE UNO");
  });

  it("el caso agregado mantiene identidad estable aunque cambie el conteo (posponer sobrevive)", () => {
    const uno = auditarDuplicados([
      { ids: ["a1", "a2"], direccion: "INGRESO", contraparte: "X", total: 100, fecha: "2026-01-01" },
    ]);
    const dos = auditarDuplicados([
      { ids: ["a1", "a2"], direccion: "INGRESO", contraparte: "X", total: 100, fecha: "2026-01-01" },
      { ids: ["b1", "b2"], direccion: "EGRESO", contraparte: "Y", total: 200, fecha: "2026-01-02" },
    ]);
    expect(uno[0].dedupeRef).toBe(dos[0].dedupeRef);
  });

  it("distingue ingreso de egreso en la sugerencia", () => {
    const ingreso = auditarDuplicados([{ ids: ["1", "2"], direccion: "INGRESO", contraparte: "X", total: 100, fecha: "2026-01-01" }]);
    const egreso = auditarDuplicados([{ ids: ["3", "4"], direccion: "EGRESO", contraparte: "Y", total: 100, fecha: "2026-01-01" }]);
    expect(ingreso[0].sugerencia).toContain("cliente");
    expect(egreso[0].sugerencia).toContain("proveedor");
  });

  it("sin grupos no emite hallazgos", () => {
    expect(auditarDuplicados([])).toHaveLength(0);
  });
});
