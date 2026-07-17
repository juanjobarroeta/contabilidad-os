import { describe, it, expect } from "vitest";
import { hayPagoVigente, nivelPago } from "./pagadores";

const EN_UNA_SEMANA = new Date(Date.now() + 7 * 86400000);
const HACE_UNA_SEMANA = new Date(Date.now() - 7 * 86400000);

describe("hayPagoVigente", () => {
  it("ACTIVE → vigente", () => {
    expect(hayPagoVigente([{ subscriptionStatus: "ACTIVE", trialEndsAt: null }])).toBe(true);
  });

  it("PAST_DUE → vigente (misma gracia que el gate de escritura)", () => {
    expect(hayPagoVigente([{ subscriptionStatus: "PAST_DUE", trialEndsAt: null }])).toBe(true);
  });

  it("TRIALING con trial en curso → vigente", () => {
    expect(hayPagoVigente([{ subscriptionStatus: "TRIALING", trialEndsAt: EN_UNA_SEMANA }])).toBe(true);
  });

  it("TRIALING con trial VENCIDO → NO vigente (computeState lo trata como EXPIRED)", () => {
    expect(hayPagoVigente([{ subscriptionStatus: "TRIALING", trialEndsAt: HACE_UNA_SEMANA }])).toBe(false);
  });

  it("EXPIRED / CANCELED → NO vigente", () => {
    expect(hayPagoVigente([{ subscriptionStatus: "EXPIRED", trialEndsAt: null }])).toBe(false);
    expect(hayPagoVigente([{ subscriptionStatus: "CANCELED", trialEndsAt: null }])).toBe(false);
  });

  it("basta UN pagador vigente entre varios vencidos", () => {
    expect(
      hayPagoVigente([
        { subscriptionStatus: "CANCELED", trialEndsAt: null },
        { subscriptionStatus: "ACTIVE", trialEndsAt: null },
      ])
    ).toBe(true);
  });

  it("sin pagadores → NO vigente", () => {
    expect(hayPagoVigente([])).toBe(false);
  });
});

describe("nivelPago", () => {
  it("ACTIVE o PAST_DUE → ACTIVO (aunque también haya un trial)", () => {
    expect(nivelPago([{ subscriptionStatus: "ACTIVE", trialEndsAt: null }])).toBe("ACTIVO");
    expect(nivelPago([{ subscriptionStatus: "PAST_DUE", trialEndsAt: null }])).toBe("ACTIVO");
    expect(
      nivelPago([
        { subscriptionStatus: "TRIALING", trialEndsAt: EN_UNA_SEMANA },
        { subscriptionStatus: "ACTIVE", trialEndsAt: null },
      ])
    ).toBe("ACTIVO");
  });

  it("sólo trial en curso → TRIAL (extracciones acotadas a la probadita)", () => {
    expect(nivelPago([{ subscriptionStatus: "TRIALING", trialEndsAt: EN_UNA_SEMANA }])).toBe("TRIAL");
  });

  it("trial vencido / cancelado / vacío → NINGUNO", () => {
    expect(nivelPago([{ subscriptionStatus: "TRIALING", trialEndsAt: HACE_UNA_SEMANA }])).toBe("NINGUNO");
    expect(nivelPago([{ subscriptionStatus: "CANCELED", trialEndsAt: null }])).toBe("NINGUNO");
    expect(nivelPago([])).toBe("NINGUNO");
  });

  it("operador de plataforma → ACTIVO siempre (empresas de la casa), aunque su status esté vencido", () => {
    expect(
      nivelPago([{ subscriptionStatus: "EXPIRED", trialEndsAt: null, esOperador: true }])
    ).toBe("ACTIVO");
    expect(
      nivelPago([{ subscriptionStatus: "TRIALING", trialEndsAt: HACE_UNA_SEMANA, esOperador: true }])
    ).toBe("ACTIVO");
  });
});
