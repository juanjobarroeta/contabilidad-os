import { describe, it, expect } from "vitest";
import {
  auditarResicoLimite,
  LIMITE_RESICO_PF,
  LIMITE_RESICO_PM,
  type ResicoLimiteData,
} from "./resico-limite";

const base = (over: Partial<ResicoLimiteData>): ResicoLimiteData => ({
  companyId: "comp1",
  kind: "pf",
  ejercicio: 2026,
  acumulado: 0,
  ...over,
});

describe("auditarResicoLimite", () => {
  it("empresa no-RESICO (kind=null) → sin hallazgos", () => {
    expect(auditarResicoLimite(base({ kind: null, acumulado: 999_999_999 }))).toHaveLength(0);
  });

  it("por debajo del 80% → sin hallazgos", () => {
    const data = base({ kind: "pf", acumulado: LIMITE_RESICO_PF * 0.5 });
    expect(auditarResicoLimite(data)).toHaveLength(0);
  });

  it("PF al 85% → warn", () => {
    const data = base({ kind: "pf", acumulado: LIMITE_RESICO_PF * 0.85 });
    const h = auditarResicoLimite(data);
    expect(h).toHaveLength(1);
    expect(h[0].checkClave).toBe("resico.ingresos_limite");
    expect(h[0].severidad).toBe("warn");
    expect(h[0].referencias).toEqual(["comp1"]);
    expect(h[0].mensaje).toContain("85%");
    expect(h[0].mensaje).toContain("saldrías del régimen");
    expect(h[0].fundamento).toEqual({ ley: "LISR", articulo: "113-E" });
  });

  it("PF al 95% → warn con mensaje más fuerte", () => {
    const data = base({ kind: "pf", acumulado: LIMITE_RESICO_PF * 0.95 });
    const h = auditarResicoLimite(data);
    expect(h).toHaveLength(1);
    expect(h[0].severidad).toBe("warn");
    expect(h[0].mensaje).toContain("95%");
    expect(h[0].mensaje).toContain("muy cerca");
  });

  it("PF al 100%+ → error", () => {
    const data = base({ kind: "pf", acumulado: LIMITE_RESICO_PF * 1.2 });
    const h = auditarResicoLimite(data);
    expect(h).toHaveLength(1);
    expect(h[0].severidad).toBe("error");
    expect(h[0].mensaje).toContain("SUPERASTE");
    expect(h[0].mensaje).toContain("120%");
  });

  it("PM usa el límite de 35 MDP y Art. 206", () => {
    const justo = base({ kind: "pm", acumulado: LIMITE_RESICO_PM * 0.85 });
    const h = auditarResicoLimite(justo);
    expect(h).toHaveLength(1);
    expect(h[0].severidad).toBe("warn");
    expect(h[0].fundamento).toEqual({ ley: "LISR", articulo: "206" });

    // El mismo monto que dispararía error en PF NO dispara nada en PM (límite 10x).
    const bajoParaPm = base({ kind: "pm", acumulado: LIMITE_RESICO_PF * 1.2 });
    expect(auditarResicoLimite(bajoParaPm)).toHaveLength(0);
  });
});
