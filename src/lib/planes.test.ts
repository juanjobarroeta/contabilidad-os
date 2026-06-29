import { describe, it, expect } from "vitest";
import {
  timbresExcedente,
  TIMBRES_INCLUIDOS,
  effectiveWhatsappPlan,
  whatsappLimites,
} from "./planes";

describe("timbresExcedente", () => {
  it("0 cuando está dentro de la cuota del tier", () => {
    expect(timbresExcedente("AUTOMATIZADO", TIMBRES_INCLUIDOS.AUTOMATIZADO - 1)).toBe(0);
    expect(timbresExcedente("AUTOMATIZADO", TIMBRES_INCLUIDOS.AUTOMATIZADO)).toBe(0);
  });
  it("cuenta sólo lo que pasa de la cuota", () => {
    expect(timbresExcedente("AUTOMATIZADO", TIMBRES_INCLUIDOS.AUTOMATIZADO + 12)).toBe(12);
  });
  it("ASISTENTE tiene la cuota más baja", () => {
    expect(TIMBRES_INCLUIDOS.ASISTENTE).toBeLessThan(TIMBRES_INCLUIDOS.AUTOMATIZADO);
  });
});

describe("effectiveWhatsappPlan", () => {
  it("una empresa de despacho hereda topes de DESPACHO aunque su tier no incluya WhatsApp", () => {
    // El bug que corrige: ASISTENTE individual daría tope 0 y bloquearía al
    // operador del despacho en la primera consulta.
    const plan = effectiveWhatsappPlan({ tier: "ASISTENTE", despachoId: "desp_1" });
    expect(plan).toBe("DESPACHO");
    expect(whatsappLimites(plan).dailyMsgsPerUser).toBeGreaterThan(0);
    expect(whatsappLimites(plan).monthlyLlmUsd).toBeGreaterThan(0);
  });

  it("una empresa independiente (sin despacho) usa su propio tier", () => {
    expect(effectiveWhatsappPlan({ tier: "PRO", despachoId: null })).toBe("PRO");
    expect(effectiveWhatsappPlan({ tier: "ASISTENTE", despachoId: null })).toBe("ASISTENTE");
  });

  it("DESPACHO da topes más altos que PRO", () => {
    expect(whatsappLimites("DESPACHO").dailyMsgsPerUser).toBeGreaterThan(
      whatsappLimites("PRO").dailyMsgsPerUser
    );
  });
});
