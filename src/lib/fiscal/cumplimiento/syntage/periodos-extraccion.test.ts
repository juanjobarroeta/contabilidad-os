import { describe, expect, it } from "vitest";
import { opcionesExtraccion, periodoHistorico, INICIO_CE } from "./periodos-extraccion";

const HOY = new Date("2026-08-08T12:00:00Z");

describe("periodoHistorico", () => {
  it("CE pide desde el inicio de la obligación (2015), no la ventana default", () => {
    expect(periodoHistorico("electronic_accounting", HOY)).toEqual({
      from: INICIO_CE,
      to: "2026-08-08",
    });
  });

  it("anuales piden 10 ejercicios (horizonte de pérdidas, Art. 57 LISR)", () => {
    expect(periodoHistorico("annual_tax_return", HOY)).toEqual({
      from: "2016-01-01",
      to: "2026-08-08",
    });
  });

  it("mensuales piden 5 años (cada acuse extra cuesta un parseo)", () => {
    expect(periodoHistorico("monthly_tax_return", HOY)).toEqual({
      from: "2021-01-01",
      to: "2026-08-08",
    });
  });

  it("CFDIs y fotos puntuales quedan sin periodo (default de Syntage)", () => {
    expect(periodoHistorico("invoice", HOY)).toBeNull();
    expect(periodoHistorico("tax_retention", HOY)).toBeNull();
    expect(periodoHistorico("tax_compliance", HOY)).toBeNull();
    expect(periodoHistorico("tax_status", HOY)).toBeNull();
  });

  it("opcionesExtraccion envuelve en { period } y omite para puntuales", () => {
    expect(opcionesExtraccion("electronic_accounting", HOY)).toEqual({
      period: { from: INICIO_CE, to: "2026-08-08" },
    });
    expect(opcionesExtraccion("tax_compliance", HOY)).toBeUndefined();
  });
});
