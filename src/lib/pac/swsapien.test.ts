import { describe, it, expect, beforeEach } from "vitest";
import { swSapienPacProvider } from "./swsapien";

const SAMPLE = {
  customerRef: "AAA010101AAA",
  paymentForm: "03",
  paymentMethod: "PUE" as const,
  use: "G03",
  items: [{ quantity: 1, product: { description: "Servicio", product_key: "84111506", price: 100 } }],
};

describe("swSapienPacProvider (guarda de seguridad)", () => {
  beforeEach(() => {
    delete process.env.SW_TOKEN;
    delete process.env.SW_USER;
    delete process.env.SW_PASSWORD;
  });

  it("se llama swsapien", () => {
    expect(swSapienPacProvider.name).toBe("swsapien");
  });

  it("sin credenciales NO timbra: devuelve needsReconfigure (nunca un CFDI a ciegas)", async () => {
    const r = await swSapienPacProvider.createCfdi("k", SAMPLE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.needsReconfigure).toBe(true);
      expect(r.kind).toBe("auth");
    }
  });

  it("cancelar sin credenciales también se rehúsa", async () => {
    const r = await swSapienPacProvider.cancelCfdi("k", "uuid", "02");
    expect(r.ok).toBe(false);
  });
});
