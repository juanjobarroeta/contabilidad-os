import { describe, expect, it } from "vitest";
import { esPersonaFisicaRfc, requiereDeclaracionAnual } from "./regimen-anual";

describe("requiereDeclaracionAnual", () => {
  it("RESICO PF puro (626) NO presenta anual — Art. 113-E, pagos definitivos", () => {
    expect(requiereDeclaracionAnual({ regimenes: ["626"], esPersonaFisica: true })).toBe(false);
  });

  it("RESICO PM (mismo código 626) SÍ presenta anual", () => {
    expect(requiereDeclaracionAnual({ regimenes: ["626"], esPersonaFisica: false })).toBe(true);
  });

  it("PF con RESICO + otro régimen sí presenta anual (por el otro)", () => {
    expect(requiereDeclaracionAnual({ regimenes: ["626", "606"], esPersonaFisica: true })).toBe(true);
  });

  it("actividad empresarial PF (612) presenta anual", () => {
    expect(requiereDeclaracionAnual({ regimenes: ["612"], esPersonaFisica: true })).toBe(true);
  });

  it("sin información de régimen: default seguro = pedir la anual", () => {
    expect(requiereDeclaracionAnual({ regimenes: [], esPersonaFisica: true })).toBe(true);
    expect(requiereDeclaracionAnual({ regimenes: [null, undefined, ""], esPersonaFisica: true })).toBe(true);
  });

  it("duplicados y nulos no confunden la regla", () => {
    expect(requiereDeclaracionAnual({ regimenes: ["626", "626", null], esPersonaFisica: true })).toBe(false);
  });
});

describe("esPersonaFisicaRfc", () => {
  it("13 caracteres = PF; 12 = PM", () => {
    expect(esPersonaFisicaRfc("TEGM961219BW1")).toBe(true);
    expect(esPersonaFisicaRfc("AMA170817NK1")).toBe(false);
    expect(esPersonaFisicaRfc(null)).toBe(false);
  });
});
