import { describe, it, expect } from "vitest";
import { esEnlaceInterno } from "./enlace";

describe("esEnlaceInterno", () => {
  it("una ruta de la app es interna", () => {
    expect(esEnlaceInterno("/contabilidad/catalogo")).toBe(true);
    expect(esEnlaceInterno("/impuestos?tab=presentar#diot")).toBe(true);
  });

  it("un ancla de la misma página es interna", () => {
    expect(esEnlaceInterno("#diot")).toBe(true);
  });

  it("un sitio externo no lo es", () => {
    expect(esEnlaceInterno("https://sat.gob.mx")).toBe(false);
    expect(esEnlaceInterno("mailto:contador@example.com")).toBe(false);
    expect(esEnlaceInterno("tel:+525555555555")).toBe(false);
  });

  it("«//otro.com» apunta fuera aunque empiece con barra", () => {
    expect(esEnlaceInterno("//otro.com/algo")).toBe(false);
  });

  it("sin href no hay enlace", () => {
    expect(esEnlaceInterno(undefined)).toBe(false);
    expect(esEnlaceInterno("")).toBe(false);
    expect(esEnlaceInterno("   ")).toBe(false);
  });
});
