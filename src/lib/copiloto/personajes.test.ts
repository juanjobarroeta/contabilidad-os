import { describe, expect, it } from "vitest";
import { colorDe, indiceColor, MAX_NOMBRE, nombreDe, PERSONAJES, sanearPiel } from "./personajes";

describe("personajes del copiloto", () => {
  it("lo corrupto o viejo vuelve al default (Cubo azul, sin nombre)", () => {
    for (const v of [null, "x", 3, { char: "gato" }]) {
      const p = sanearPiel(v);
      expect(p.char).toBe("blob");
      expect(nombreDe(p)).toBe("Cubo");
      expect(colorDe(p)).toBe(PERSONAJES.blob.colores[0][1]);
    }
  });

  it("conserva el color por personaje y descarta índices fuera de rango", () => {
    const p = sanearPiel({ char: "shiba", name: null, colors: { shiba: 2, owl: 9, blob: 1.5 } });
    expect(indiceColor(p)).toBe(2);
    expect(colorDe(p)).toBe(PERSONAJES.shiba.colores[2][1]);
    expect(indiceColor(p, "owl")).toBe(0);
    expect(indiceColor(p, "blob")).toBe(0);
  });

  it("el nombre se recorta a 16 y vacío usa el del personaje", () => {
    expect(nombreDe(sanearPiel({ char: "owl", name: "   " }))).toBe("Lupa");
    expect(nombreDe(sanearPiel({ char: "owl", name: "  Sabio  " }))).toBe("Sabio");
    expect(nombreDe(sanearPiel({ char: "owl", name: "x".repeat(40) }))).toHaveLength(MAX_NOMBRE);
  });

  it("cada personaje trae cuatro colores", () => {
    for (const p of Object.values(PERSONAJES)) expect(p.colores).toHaveLength(4);
  });
});
