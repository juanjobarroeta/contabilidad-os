import { describe, expect, it } from "vitest";
import { palabrasDe, sinAcentos } from "./proveedores-buscar";

describe("búsqueda de proveedores", () => {
  it("quita acentos y separa por palabra", () => {
    expect(sinAcentos("Médica Ñandú")).toBe("MEDICA NANDU");
    expect(palabrasDe("  distribuidora  médica, s.a. ")).toEqual(["DISTRIBUIDORA", "MEDICA", "SA"]);
  });
  it("conserva & y trata Ñ como N (igual que en la base)", () => {
    expect(palabrasDe("P&G")).toEqual(["P&G"]);
    expect(palabrasDe("Peña")).toEqual(["PENA"]);
  });
  it("vacío no busca nada", () => {
    expect(palabrasDe(" , ")).toEqual([]);
  });
});
