import { describe, it, expect } from "vitest";
import { mesDeLote, periodoDeTexto } from "./periodo-lote";

describe("periodoDeTexto — lo que de verdad escriben los bancos", () => {
  it("el CSV ya viene normalizado", () => {
    expect(periodoDeTexto("2026-08")).toBe("2026-08");
  });

  it("Banorte: «Del 01/Agosto/2026 al 31/Agosto/2026»", () => {
    expect(periodoDeTexto("Del 01/Agosto/2026 al 31/Agosto/2026")).toBe("2026-08");
  });

  it("BBVA: «DEL 01/08/2026 AL 31/08/2026»", () => {
    expect(periodoDeTexto("DEL 01/08/2026 AL 31/08/2026")).toBe("2026-08");
  });

  it("Santander: «DEL 01-JUL-2026 AL 31-JUL-2026»", () => {
    expect(periodoDeTexto("DEL 01-JUL-2026 AL 31-JUL-2026")).toBe("2026-07");
  });

  it("nombre suelto, con o sin «de», con acento o sin él", () => {
    expect(periodoDeTexto("Agosto 2026")).toBe("2026-08");
    expect(periodoDeTexto("agosto de 2026")).toBe("2026-08");
    expect(periodoDeTexto("Sept. 2026")).toBe("2026-09");
  });

  it("un rango que cruza dos meses NO tiene un mes: null, no una adivinanza", () => {
    expect(periodoDeTexto("DEL 15/07/2026 AL 14/08/2026")).toBeNull();
  });

  it("sin mención de mes, o vacío → null", () => {
    expect(periodoDeTexto("Estado de cuenta")).toBeNull();
    expect(periodoDeTexto(null)).toBeNull();
    expect(periodoDeTexto("")).toBeNull();
    // Un día suelto no es un mes.
    expect(periodoDeTexto("día 15")).toBeNull();
  });
});

describe("mesDeLote — las fechas de los movimientos mandan", () => {
  it("con movimientos del mismo mes, ése es el mes aunque el texto sea otro", () => {
    expect(
      mesDeLote({ periodo: "Del 01/Agosto/2026 al 31/Agosto/2026", minFecha: new Date("2026-08-01T00:00:00Z"), maxFecha: new Date("2026-08-31T00:00:00Z") }),
    ).toBe("2026-08");
    // El texto está mal (o es de otro lote): las fechas ganan.
    expect(
      mesDeLote({ periodo: "julio 2026", minFecha: new Date("2026-08-03T00:00:00Z"), maxFecha: new Date("2026-08-28T00:00:00Z") }),
    ).toBe("2026-08");
  });

  it("el corte es UTC, como el resto de Bancos: el 1 a las 00:30 UTC es del mes", () => {
    expect(
      mesDeLote({ periodo: null, minFecha: new Date("2026-08-01T00:30:00Z"), maxFecha: new Date("2026-08-31T23:00:00Z") }),
    ).toBe("2026-08");
  });

  it("movimientos en dos meses → cae al texto; sin texto útil → null", () => {
    expect(
      mesDeLote({ periodo: "DEL 01/08/2026 AL 31/08/2026", minFecha: new Date("2026-07-31T00:00:00Z"), maxFecha: new Date("2026-08-31T00:00:00Z") }),
    ).toBe("2026-08");
    expect(mesDeLote({ periodo: null, minFecha: new Date("2026-07-31T00:00:00Z"), maxFecha: new Date("2026-08-31T00:00:00Z") })).toBeNull();
  });

  it("sin movimientos, el texto decide", () => {
    expect(mesDeLote({ periodo: "DEL 01-JUL-2026 AL 31-JUL-2026" })).toBe("2026-07");
  });
});
