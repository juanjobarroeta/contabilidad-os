import { describe, expect, it } from "vitest";
import { evaluarCoberturaFiscal } from "./cobertura-datos";

function coberturaInpc(asOf: Date) {
  const dataset = evaluarCoberturaFiscal(asOf).datasets.find((d) => d.clave === "INPC");
  expect(dataset).toBeDefined();
  return dataset!;
}

describe("INPC publication-aware coverage", () => {
  it("does not require August before its September publication date", () => {
    expect(coberturaInpc(new Date(2026, 8, 8, 12))).toMatchObject({
      ultimoCargado: "2026-08",
      ultimoEsperado: "2026-07",
      estado: "sin_cotejar",
    });
  });

  it("requires August on its September publication date", () => {
    expect(coberturaInpc(new Date(2026, 8, 9, 12))).toMatchObject({
      ultimoCargado: "2026-08",
      ultimoEsperado: "2026-08",
      estado: "sin_cotejar",
    });
  });

  it("fails freshness closed when the next published month is absent", () => {
    expect(coberturaInpc(new Date(2026, 9, 9, 12))).toMatchObject({
      ultimoCargado: "2026-08",
      ultimoEsperado: "2026-09",
      estado: "faltante",
      verificado: false,
    });
  });
});
