import { describe, expect, it } from "vitest";
import { separarFirmas, textoFirma } from "./firmas";

describe("separarFirmas", () => {
  it("sin marca deja la descripción intacta", () => {
    expect(separarFirmas("Servicio de mantenimiento")).toEqual({ texto: "Servicio de mantenimiento", firmas: [] });
  });

  it("separa texto, cuenta y dos firmas con cargo", () => {
    const d =
      "ESTIMACION 1 NORMAL. Numero de Cuenta: 5588 Firma: C. Edgar Dávila Ramos / Subsecretario de Infraestructura " +
      "Firma: C. Rodrigo Enrique Álvarez S. / Secretario del Consejo de Admon";
    expect(separarFirmas(d)).toEqual({
      texto: "ESTIMACION 1 NORMAL. Numero de Cuenta: 5588",
      firmas: [
        { nombre: "C. Edgar Dávila Ramos", cargo: "Subsecretario de Infraestructura" },
        { nombre: "C. Rodrigo Enrique Álvarez S.", cargo: "Secretario del Consejo de Admon" },
      ],
    });
  });

  it("firma sin cargo y marca en minúsculas", () => {
    expect(separarFirmas("Obra firma: Juan Pérez").firmas).toEqual([{ nombre: "Juan Pérez", cargo: null }]);
  });

  it("no confunde palabras que contienen 'firma'", () => {
    expect(separarFirmas("Contrato confirma: entrega").firmas).toEqual([]);
  });

  it("cargo puede contener barras", () => {
    expect(separarFirmas("X Firma: Ana / Jefa de Obras / Supervisión").firmas[0]).toEqual({ nombre: "Ana", cargo: "Jefa de Obras / Supervisión" });
  });

  it("textoFirma produce algo que separarFirmas lee", () => {
    expect(separarFirmas(`Obra ${textoFirma(" Ana ", "Jefa ")}`).firmas).toEqual([{ nombre: "Ana", cargo: "Jefa" }]);
  });
});
