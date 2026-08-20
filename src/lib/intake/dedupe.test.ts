import { describe, expect, it } from "vitest";
import { titleSimilarity, titleTokens, titlesLookDuplicate } from "./dedupe";

describe("titleTokens", () => {
  it("normaliza acentos, minúsculas y stopwords", () => {
    const tokens = titleTokens("Descarga masiva de CFDIs para el período");
    expect(tokens.has("descarga")).toBe(true);
    expect(tokens.has("cfdis")).toBe(true);
    expect(tokens.has("periodo")).toBe(true); // sin acento
    expect(tokens.has("de")).toBe(false); // stopword
    expect(tokens.has("el")).toBe(false);
  });
});

describe("titleSimilarity", () => {
  it("dos redacciones del mismo pedido superan el umbral", () => {
    expect(
      titlesLookDuplicate(
        "Descarga masiva de CFDIs por rango de fechas",
        "Descargar CFDIs masiva por rango"
      )
    ).toBe(true);
  });

  it("pedidos distintos no se marcan", () => {
    expect(
      titlesLookDuplicate(
        "Descarga masiva de CFDIs por rango de fechas",
        "Exportar órdenes de servicio a Excel"
      )
    ).toBe(false);
  });

  it("títulos vacíos dan 0", () => {
    expect(titleSimilarity("", "algo")).toBe(0);
  });
});
