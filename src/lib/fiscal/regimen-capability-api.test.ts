import { describe, expect, it } from "vitest";
import { calculationForApi } from "./regimen-capability-api";
import { RegimenCalculationNotSupportedError } from "./regimen-capabilities";

describe("regimen calculation API contract", () => {
  it("returns stable 422 NOT_SUPPORTED JSON", async () => {
    const error = new RegimenCalculationNotSupportedError("MONTHLY", "ASSISTED_ONLY", {
      code: "603",
      trackId: "603",
      label: "Personas Morales con Fines no Lucrativos",
      tipoPersona: "PM",
      capability: "ASSISTED",
    });

    const response = await calculationForApi(Promise.reject(error));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(422);
    await expect((response as Response).json()).resolves.toMatchObject({
      code: "NOT_SUPPORTED",
      title: "Cálculo asistido por tu contador",
      calculation: "MONTHLY",
      reason: "ASSISTED_ONLY",
      regimen: { code: "603", trackId: "603", capability: "ASSISTED" },
    });
  });

  it("does not hide unrelated calculation failures", async () => {
    await expect(calculationForApi(Promise.reject(new Error("database unavailable")))).rejects.toThrow(
      "database unavailable",
    );
  });
});
