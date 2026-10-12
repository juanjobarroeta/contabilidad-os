import { describe, expect, it } from "vitest";
import { leerPeriodoDeclarado, mesDeCobertura, mesEspanol } from "./periodo-declarado";

// Los cinco estados de agosto 2026 de CENTRO guardaron el periodo tal como lo
// imprime cada banco y quedaron «Sin mes». Estos son esos textos.
describe("leerPeriodoDeclarado", () => {
  it.each([
    ["Periodo DEL 01/08/2026 AL 31/08/2026", "2026-08-01", "2026-08-31"], // BBVA
    ["DEL 01-AGO-2026 AL 31-AGO-2026", "2026-08-01", "2026-08-31"], // Santander
    ["DEL 01-JUL-2026 AL 31-JUL-2026", "2026-07-01", "2026-07-31"], // Santander julio
    ["Del 01/Agosto/2026 al 31/Agosto/2026", "2026-08-01", "2026-08-31"], // Banorte
    ["del 01/Septiembre/2026 al 30/Septiembre/2026", "2026-09-01", "2026-09-30"],
    ["DEL 01/12/2026 AL 31/01/2027", "2026-12-01", "2027-01-31"],
  ])("%s", (texto, inicio, fin) => {
    expect(leerPeriodoDeclarado(texto)).toEqual({ inicio, fin });
  });
  it("no adivina un periodo a medias ni fechas imposibles", () => {
    expect(leerPeriodoDeclarado("Fecha de corte 31/08/2026")).toBeNull();
    expect(leerPeriodoDeclarado("DEL 31/02/2026 AL 28/02/2026")).toBeNull();
    expect(leerPeriodoDeclarado("DEL 31/08/2026 AL 01/08/2026")).toBeNull();
    expect(leerPeriodoDeclarado(null)).toBeNull();
  });
  it("lee meses en abreviatura y con acento o punto", () => {
    expect(mesEspanol("AGO")).toBe(8);
    expect(mesEspanol("Sept.")).toBe(9);
    expect(mesEspanol("Díc.")).toBe(12);
    expect(mesEspanol("Agostoo")).toBeNull();
  });
});

describe("mesDeCobertura", () => {
  it("el inicio declarado manda", () => {
    expect(mesDeCobertura({ periodStart: "2026-01-01", periodo: "2025-01-09 – 2026-01-30" })).toEqual({ year: 2026, month: 1 });
  });
  it("sin inicio, lee el texto impreso guardado", () => {
    expect(mesDeCobertura({ periodStart: null, periodo: "Del 01/Agosto/2026 al 31/Agosto/2026" })).toEqual({ year: 2026, month: 8 });
    expect(mesDeCobertura({ periodStart: null, periodo: "DEL 01-JUL-2026 AL 31-JUL-2026" })).toEqual({ year: 2026, month: 7 });
  });
  it("conserva el formato AAAA-MM", () => {
    expect(mesDeCobertura({ periodo: "2026-05" })).toEqual({ year: 2026, month: 5 });
  });
  it("sin nada legible, null", () => {
    expect(mesDeCobertura({ periodo: "agosto" })).toBeNull();
  });
});
