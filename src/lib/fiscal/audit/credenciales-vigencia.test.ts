import { describe, it, expect } from "vitest";
import {
  auditarCredencialesVigencia,
  UMBRAL_DIAS,
  type CredencialesVigencia,
} from "./credenciales-vigencia";

const HOY = new Date("2026-06-27T00:00:00.000Z");
const DIA_MS = 24 * 60 * 60 * 1000;

function enDias(n: number): Date {
  return new Date(HOY.getTime() + n * DIA_MS);
}

function data(over: Partial<CredencialesVigencia>): CredencialesVigencia {
  return { companyId: "co_1", csdVigencia: null, fielVigencia: null, ...over };
}

describe("auditarCredencialesVigencia", () => {
  it("no emite hallazgos cuando faltan ambas vigencias", () => {
    expect(auditarCredencialesVigencia(data({}), HOY)).toEqual([]);
  });

  it("no emite hallazgo para una credencial vigente y holgada", () => {
    const out = auditarCredencialesVigencia(
      data({ csdVigencia: enDias(180), fielVigencia: enDias(365) }),
      HOY,
    );
    expect(out).toEqual([]);
  });

  it("emite error cuando el CSD ya venció", () => {
    const out = auditarCredencialesVigencia(data({ csdVigencia: enDias(-5) }), HOY);
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.checkClave).toBe("csd.por_vencer");
    expect(h.severidad).toBe("error");
    expect(h.referencias).toEqual(["co_1"]);
    expect(h.fundamento).toEqual({ ley: "CFF", articulo: "17-D" });
    expect(h.mensaje).toContain("venció hace 5 días");
  });

  it("emite warn cuando la e.firma está por vencer dentro del umbral", () => {
    const out = auditarCredencialesVigencia(data({ fielVigencia: enDias(10) }), HOY);
    expect(out).toHaveLength(1);
    const h = out[0];
    expect(h.checkClave).toBe("fiel.por_vencer");
    expect(h.severidad).toBe("warn");
    expect(h.mensaje).toContain("vence en 10 días");
  });

  it("no emite warn justo fuera del umbral", () => {
    const out = auditarCredencialesVigencia(
      data({ csdVigencia: enDias(UMBRAL_DIAS + 1) }),
      HOY,
    );
    expect(out).toEqual([]);
  });

  it("emite dos hallazgos independientes (CSD vencido + e.firma por vencer)", () => {
    const out = auditarCredencialesVigencia(
      data({ csdVigencia: enDias(-1), fielVigencia: enDias(3) }),
      HOY,
    );
    expect(out).toHaveLength(2);
    expect(out.map((h) => [h.checkClave, h.severidad])).toEqual([
      ["csd.por_vencer", "error"],
      ["fiel.por_vencer", "warn"],
    ]);
  });
});
