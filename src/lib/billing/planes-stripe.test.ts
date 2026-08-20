import { describe, expect, it } from "vitest";
import {
  PLAN_A_TIER,
  parseComplementos,
  parseIntervaloFacturable,
  parsePlanFacturable,
  priceIdForComplemento,
  priceIdForPlan,
} from "./planes-stripe";

describe("parsePlanFacturable", () => {
  it("acepta los tres planes facturables", () => {
    expect(parsePlanFacturable("BASICO")).toBe("BASICO");
    expect(parsePlanFacturable("PROFESIONAL")).toBe("PROFESIONAL");
    // DESPACHO dejó de ser facturable: ahora es un plan desconocido.
    expect(parsePlanFacturable("DESPACHO")).toBeNull();
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

describe("parseIntervaloFacturable", () => {
  it("acepta mensual y anual", () => {
    expect(parseIntervaloFacturable("mensual")).toBe("mensual");
    expect(parseIntervaloFacturable("anual")).toBe("anual");
  });

  it("ausente (undefined/null) → mensual por default", () => {
    expect(parseIntervaloFacturable(undefined)).toBe("mensual");
    expect(parseIntervaloFacturable(null)).toBe("mensual");
  });

  it("valores no reconocidos → null (400 en la ruta)", () => {
    expect(parseIntervaloFacturable("ANUAL")).toBeNull();
    expect(parseIntervaloFacturable("yearly")).toBeNull();
    expect(parseIntervaloFacturable("")).toBeNull();
    expect(parseIntervaloFacturable(12)).toBeNull();
  });
});

describe("priceIdForPlan", () => {
  const envMensual = {
    STRIPE_PRICE_BASICO: "price_basico_123",
    STRIPE_PRICE_PRO: "price_pro_456",
  };
  const envCompleto = {
    ...envMensual,
    STRIPE_PRICE_BASICO_ANUAL: "price_basico_anual",
    STRIPE_PRICE_PRO_ANUAL: "price_pro_anual",
  };

  it("resuelve el price mensual de cada plan desde el entorno", () => {
    expect(priceIdForPlan("BASICO", "mensual", envMensual)).toBe("price_basico_123");
    // PROFESIONAL usa la variable STRIPE_PRICE_PRO
    expect(priceIdForPlan("PROFESIONAL", "mensual", envMensual)).toBe("price_pro_456");
  });

  it("el intervalo default es mensual", () => {
    expect(priceIdForPlan("BASICO", undefined, envCompleto)).toBe("price_basico_123");
  });

  it("resuelve el price anual de cada plan (variables *_ANUAL)", () => {
    expect(priceIdForPlan("BASICO", "anual", envCompleto)).toBe("price_basico_anual");
    expect(priceIdForPlan("PROFESIONAL", "anual", envCompleto)).toBe("price_pro_anual");
  });

  it("anual sin variable *_ANUAL → null aunque el mensual exista (503 con mensaje)", () => {
    expect(priceIdForPlan("BASICO", "anual", envMensual)).toBeNull();
    expect(priceIdForPlan("PROFESIONAL", "anual", envMensual)).toBeNull();
  });

  it("mensual sin variable → null aunque el anual exista (no se cruzan)", () => {
    expect(priceIdForPlan("BASICO", "mensual", { STRIPE_PRICE_BASICO_ANUAL: "x" })).toBeNull();
  });

  it("devuelve null cuando la variable no está definida", () => {
    expect(priceIdForPlan("BASICO", "mensual", {})).toBeNull();
    expect(priceIdForPlan("PROFESIONAL", "mensual", { STRIPE_PRICE_BASICO: "x" })).toBeNull();
  });

  it("trata la cadena vacía o espacios como no configurado", () => {
    expect(priceIdForPlan("BASICO", "mensual", { STRIPE_PRICE_BASICO: "" })).toBeNull();
    expect(priceIdForPlan("BASICO", "mensual", { STRIPE_PRICE_BASICO: "   " })).toBeNull();
    expect(priceIdForPlan("BASICO", "anual", { STRIPE_PRICE_BASICO_ANUAL: "  " })).toBeNull();
  });

  it("recorta espacios del price id", () => {
    expect(priceIdForPlan("BASICO", "mensual", { STRIPE_PRICE_BASICO: " price_x " })).toBe(
      "price_x",
    );
  });
});

describe("parseComplementos", () => {
  it("acepta las claves conocidas y deduplica", () => {
    expect(parseComplementos(["PURIFICADORA"])).toEqual(["PURIFICADORA"]);
    expect(parseComplementos(["PURIFICADORA", "PURIFICADORA"])).toEqual(["PURIFICADORA"]);
  });

  // El cliente pide por CLAVE: nunca debe poder colar un price arbitrario ni
  // basura en las partidas del checkout.
  it("ignora claves desconocidas, price ids y valores que no son arreglo", () => {
    expect(parseComplementos(["price_1Malicioso"])).toEqual([]);
    expect(parseComplementos(["OTRO_MODULO"])).toEqual([]);
    expect(parseComplementos(["PURIFICADORA", 42, null])).toEqual(["PURIFICADORA"]);
    expect(parseComplementos("PURIFICADORA")).toEqual([]);
    expect(parseComplementos(undefined)).toEqual([]);
  });
});

describe("priceIdForComplemento", () => {
  it("resuelve el price del entorno", () => {
    expect(priceIdForComplemento("PURIFICADORA", { STRIPE_PRICE_PURIFICADORA: "price_p" })).toBe(
      "price_p",
    );
  });

  it("null si no está configurado (el checkout simplemente lo omite)", () => {
    expect(priceIdForComplemento("PURIFICADORA", {})).toBeNull();
    expect(priceIdForComplemento("PURIFICADORA", { STRIPE_PRICE_PURIFICADORA: "  " })).toBeNull();
  });
});

describe("PLAN_A_TIER", () => {
  it("mapea cada plan comprado al tier de capacidades correcto", () => {
    expect(PLAN_A_TIER.BASICO).toBe("AUTOMATIZADO");
    expect(PLAN_A_TIER.PROFESIONAL).toBe("PRO");
  });
});
