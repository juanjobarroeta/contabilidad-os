import { describe, expect, it } from "vitest";
import {
  PLAN_A_TIER,
  parsePlanFacturable,
  priceIdForPlan,
} from "./planes-stripe";

describe("parsePlanFacturable", () => {
  it("acepta los tres planes facturables", () => {
    expect(parsePlanFacturable("BASICO")).toBe("BASICO");
    expect(parsePlanFacturable("PROFESIONAL")).toBe("PROFESIONAL");
    expect(parsePlanFacturable("DESPACHO")).toBe("DESPACHO");
  });

  it("rechaza valores inválidos", () => {
    expect(parsePlanFacturable("PRO")).toBeNull(); // nombre de env, no de plan
    expect(parsePlanFacturable("basico")).toBeNull();
    expect(parsePlanFacturable("")).toBeNull();
    expect(parsePlanFacturable(undefined)).toBeNull();
    expect(parsePlanFacturable(42)).toBeNull();
    expect(parsePlanFacturable(null)).toBeNull();
  });
});

describe("priceIdForPlan", () => {
  const env = {
    STRIPE_PRICE_BASICO: "price_basico_123",
    STRIPE_PRICE_PRO: "price_pro_456",
    STRIPE_PRICE_DESPACHO: "price_despacho_789",
  };

  it("resuelve el price de cada plan desde el entorno", () => {
    expect(priceIdForPlan("BASICO", env)).toBe("price_basico_123");
    // PROFESIONAL usa la variable STRIPE_PRICE_PRO
    expect(priceIdForPlan("PROFESIONAL", env)).toBe("price_pro_456");
    expect(priceIdForPlan("DESPACHO", env)).toBe("price_despacho_789");
  });

  it("devuelve null cuando la variable no está definida", () => {
    expect(priceIdForPlan("BASICO", {})).toBeNull();
    expect(priceIdForPlan("PROFESIONAL", { STRIPE_PRICE_BASICO: "x" })).toBeNull();
  });

  it("trata la cadena vacía o espacios como no configurado", () => {
    expect(priceIdForPlan("BASICO", { STRIPE_PRICE_BASICO: "" })).toBeNull();
    expect(priceIdForPlan("BASICO", { STRIPE_PRICE_BASICO: "   " })).toBeNull();
  });

  it("recorta espacios del price id", () => {
    expect(priceIdForPlan("DESPACHO", { STRIPE_PRICE_DESPACHO: " price_x " })).toBe("price_x");
  });
});

describe("PLAN_A_TIER", () => {
  it("mapea cada plan comprado al tier de capacidades correcto", () => {
    expect(PLAN_A_TIER.BASICO).toBe("AUTOMATIZADO");
    expect(PLAN_A_TIER.PROFESIONAL).toBe("PRO");
    expect(PLAN_A_TIER.DESPACHO).toBe("DESPACHO");
  });
});
