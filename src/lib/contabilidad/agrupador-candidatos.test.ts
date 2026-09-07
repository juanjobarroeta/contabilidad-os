import { describe, it, expect } from "vitest";
import { candidatosAgrupador, normalizar, PREFIJOS_POR_TIPO } from "./agrupador-candidatos";

describe("candidatosAgrupador", () => {
  it("propone bancos para una cuenta de bancos", () => {
    const c = candidatosAgrupador({ nombre: "Bancos nacionales", tipo: "ACTIVO" });
    expect(c[0].codigo).toBe("102.01");
  });

  it("nunca sale de la clase de la cuenta", () => {
    const c = candidatosAgrupador({ nombre: "Bancos nacionales", tipo: "GASTO" });
    expect(c.length).toBeGreaterThan(0);
    for (const x of c) expect(["6", "7"]).toContain(x.codigo[0]);
  });

  it("sin ninguna palabra en común devuelve la clase completa, no una lista vacía", () => {
    const c = candidatosAgrupador({ nombre: "Zzzzq Wxyq", tipo: "CAPITAL" });
    expect(c.length).toBeGreaterThan(0);
    for (const x of c) expect(x.codigo.startsWith("3")).toBe(true);
    expect(c.every((x) => x.coincidencias === 0)).toBe(true);
  });

  it("ignora acentos, mayúsculas y palabras vacías", () => {
    expect(normalizar("Depreciación de Mobiliario")).toBe("depreciacion de mobiliario");
    const c = candidatosAgrupador({ nombre: "CLIENTES", tipo: "ACTIVO" });
    expect(c[0].nombre.toLowerCase()).toContain("cliente");
  });

  it("respeta el tope", () => {
    expect(candidatosAgrupador({ nombre: "Otros", tipo: "GASTO" }, { max: 5 })).toHaveLength(5);
  });

  it("es determinista", () => {
    const a = candidatosAgrupador({ nombre: "Impuestos por pagar", tipo: "PASIVO" });
    const b = candidatosAgrupador({ nombre: "Impuestos por pagar", tipo: "PASIVO" });
    expect(a).toEqual(b);
  });

  it("cada tipo tiene al menos un prefijo", () => {
    for (const [tipo, prefijos] of Object.entries(PREFIJOS_POR_TIPO)) {
      expect(prefijos.length, tipo).toBeGreaterThan(0);
    }
  });
});
