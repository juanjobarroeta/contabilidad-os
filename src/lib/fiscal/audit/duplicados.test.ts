import { describe, it, expect } from "vitest";
import { auditarDuplicados, type GrupoDuplicado } from "./duplicados";

describe("auditarDuplicados", () => {
  it("emite un hallazgo por grupo, referenciando todos los CFDIs", () => {
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
