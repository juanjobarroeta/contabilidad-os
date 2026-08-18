import { describe, it, expect } from "vitest";
import { SatParsePagadoError } from "./parse";

// El contrato que evita el ciclo de Canales: un fallo DESPUÉS de pagar se
// distingue por tipo, para que el sync marque acuseParseadoAt en vez de
// reintentar (y re-pagar) cada corrida.
describe("SatParsePagadoError", () => {
  it("se distingue de un error cualquiera y declara que ya costó", () => {
    const e = new SatParsePagadoError("respuesta no interpretable", "Aquí está: {ro");
    expect(e).toBeInstanceOf(Error);
    expect(e.pagado).toBe(true);
    expect(e.name).toBe("SatParsePagadoError");
    expect(e.crudo).toContain("Aquí está");
  });

  it("un error de red normal NO trae la marca de pagado", () => {
    const e = new Error("fetch failed") as Error & { pagado?: boolean };
    expect(e.pagado).toBeUndefined();
  });
});
