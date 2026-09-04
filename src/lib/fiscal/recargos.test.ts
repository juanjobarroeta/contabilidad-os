import { describe, expect, it } from "vitest";
import { coberturaRecargos, recargosPorMora, tasaMoraDesdeProrroga, tasasRecargos } from "./recargos";

describe("recargos (datos generados de la LIF)", () => {
  it("2026: prórroga 1.38 % (Art. 11 LIF) → mora 2.07 % (Art. 21 CFF)", () => {
    const t = tasasRecargos("2026-09-04");
    expect(t).toMatchObject({ ejercicio: 2026, articulo: "11", prorroga: 0.0138, mora: 0.0207, verificado: true });
    expect(t?.parcialidades.map((p) => p.tasa)).toEqual([0.0142, 0.0163, 0.0197]);
  });
  it("mora = prórroga × 1.5 a 4 decimales", () => {
    expect(tasaMoraDesdeProrroga(0.0098)).toBe(0.0147);
    expect(tasaMoraDesdeProrroga(0.0138)).toBe(0.0207);
  });
  it("recargos por mora: cada mes o fracción cuenta entero; tope 60 meses", () => {
    expect(recargosPorMora(10000, 2.2, "2026-05-01")).toEqual({ recargos: 621, tasaMensual: 0.0207, meses: 3 });
    expect(recargosPorMora(10000, 80, "2026-05-01")?.meses).toBe(60);
    expect(recargosPorMora(0, 3)).toBeNull();
    expect(recargosPorMora(10000, 3, "2010-01-01")).toBeNull();
  });
  it("cobertura", () => {
    expect(coberturaRecargos()?.ejercicio).toBeGreaterThanOrEqual(2026);
  });
});
