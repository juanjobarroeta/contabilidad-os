import { describe, expect, it } from "vitest";
import { MATERIAS, MATERIAS_CONTADOR, MATERIAS_POR_CLAVE, clasificarMaterias, esMateria } from "./materias";

describe("clasificarMaterias", () => {
  it("la clave revisada a mano manda sobre las reglas", () => {
    expect(clasificarMaterias("LFT", "Ley Federal del Trabajo")).toEqual(["laboral"]);
    expect(clasificarMaterias("LFGR", "Ley de la Fiscalía General de la República")).not.toContain("fiscal");
  });
  it("reglas por título: varias materias, sin repetir", () => {
    const m = clasificarMaterias("LFPIORPI-X", "Ley Federal para la Prevención e Identificación de Operaciones con Recursos de Procedencia Ilícita");
    expect(m).toContain("pld");
    expect(new Set(m).size).toBe(m.length);
  });
  it("«Fiscalía» no es fiscal; «Fiscal» sí", () => {
    expect(clasificarMaterias("X1", "Ley de la Fiscalía General")).not.toContain("fiscal");
    expect(clasificarMaterias("X2", "Código Fiscal de la Federación")).toContain("fiscal");
  });
  it("una ley reglamentaria de una fracción constitucional es constitucional", () => {
    expect(clasificarMaterias("X3", "LEY Reglamentaria de la Fracción V del Artículo 76 de la Constitución")).toContain("constitucional");
  });
  it("sin regla que aplique cae en administrativo, nunca vacío", () => {
    expect(clasificarMaterias("X4", "Ley de Algo Sin Pistas")).toEqual(["administrativo"]);
  });
});

describe("taxonomía", () => {
  it("las materias del contador y las revisadas a mano son materias válidas", () => {
    for (const m of MATERIAS_CONTADOR) expect(esMateria(m)).toBe(true);
    for (const [clave, ms] of Object.entries(MATERIAS_POR_CLAVE)) {
      expect(ms.length, clave).toBeGreaterThan(0);
      for (const m of ms) expect(esMateria(m), `${clave}: ${m}`).toBe(true);
    }
    expect(new Set(MATERIAS).size).toBe(MATERIAS.length);
  });
  it("constitucional queda fuera del contador a propósito (ver comentario en materias.ts)", () => {
    expect(MATERIAS_CONTADOR).not.toContain("constitucional");
  });
});
