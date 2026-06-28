import { describe, it, expect } from "vitest";
import { facturapiTimbreMicroUsd, microUsdACentavosMxn, FACTURAPI_TIMBRE_MXN } from "./rates";

describe("facturapiTimbreMicroUsd", () => {
  it("un timbre ≈ $0.60 MXN al mostrar con FIX de referencia (~20)", () => {
    const micro = facturapiTimbreMicroUsd(1);
    const centavos = microUsdACentavosMxn(micro, 20);
    expect(centavos).toBe(Math.round(FACTURAPI_TIMBRE_MXN * 100)); // 60 centavos
  });

  it("escala lineal con el número de timbres", () => {
    expect(facturapiTimbreMicroUsd(10)).toBe(facturapiTimbreMicroUsd(1) * 10);
  });
});
