import { describe, expect, it } from "vitest";
import { citasEnProsa, construirIndice, normalizarTitulo } from "./citas-prosa";

const indice = construirIndice([
  { clave: "CHH-C-PROCEDIMIENTOS-FAMILIARES-CH", titulo: "Código de Procedimientos Familiares del Estado de Chihuahua", entidad: "CHH" },
  { clave: "CHH-C-PROCEDIMIENTOS-CIVILES-CHIHU", titulo: "Código de Procedimientos Civiles del Estado de Chihuahua", entidad: "CHH" },
  { clave: "PUE-C-CIVIL-PUEBLA", titulo: "Código Civil para el Estado Libre y Soberano de Puebla", entidad: "PUE" },
  { clave: "CNPCF", titulo: "Código Nacional de Procedimientos Civiles y Familiares" },
  { clave: "LISR", titulo: "Ley del Impuesto sobre la Renta" },
]);

describe("citas en prosa", () => {
  it("reconoce el artículo por el nombre completo del ordenamiento", () => {
    const t = "Conforme al artículo 486 del Código de Procedimientos Familiares del Estado de Chihuahua, la apelación procede en efecto devolutivo.";
    const c = citasEnProsa(t, indice);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ cita: "ART. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH", articulo: "486", clave: "CHH-C-PROCEDIMIENTOS-FAMILIARES-CH" });
    expect(t.slice(c[0].inicio, c[0].fin)).toBe(c[0].textoEnRespuesta);
  });

  it("no confunde dos códigos parecidos del mismo estado", () => {
    const t = "El artículo 46 del Código de Procedimientos Civiles del Estado de Chihuahua y el artículo 7 del Código de Procedimientos Familiares del Estado de Chihuahua.";
    expect(citasEnProsa(t, indice).map((c) => c.clave)).toEqual(["CHH-C-PROCEDIMIENTOS-CIVILES-CHIHU", "CHH-C-PROCEDIMIENTOS-FAMILIARES-CH"]);
  });

  it("el título más largo gana: «Civiles y Familiares» no cae en «Civiles»", () => {
    const t = "Ver el artículo 910 del Código Nacional de Procedimientos Civiles y Familiares.";
    expect(citasEnProsa(t, indice)[0].clave).toBe("CNPCF");
  });

  it("aguanta fracción, «Bis» y la forma abreviada de artículo", () => {
    const t = "Los arts. 27 de la Ley del Impuesto sobre la Renta; el artículo 30 Bis del Código Civil para el Estado Libre y Soberano de Puebla; y el artículo 1934, fracción II, del Código Civil para el Estado Libre y Soberano de Puebla.";
    const c = citasEnProsa(t, indice);
    expect(c.map((x) => x.cita)).toEqual(["ART. 27 LISR", "ART. 30 BIS PUE-C-CIVIL-PUEBLA", "ART. 1934 PUE-C-CIVIL-PUEBLA"]);
  });

  it("una ley inventada NO se resuelve (que la marque el verificador)", () => {
    expect(citasEnProsa("Según el artículo 5 de la Ley Federal de Cosas Imaginarias, procede.", indice)).toEqual([]);
  });

  it("un título de dos palabras no entra al índice: aparecería en cualquier frase", () => {
    const corto = construirIndice([{ clave: "X", titulo: "Ley Aduanera" }]);
    expect(corto).toHaveLength(0);
    expect(normalizarTitulo("Código Civil para el Estado Libre y Soberano de Puebla")).toBe("codigo civil libre y soberano puebla");
  });
});

describe("tres citas seguidas sin puntuación entre ellas", () => {
  it("cada una se corta donde termina SU título (el bug que se comió la tercera)", () => {
    const t = "el artículo 486 del Código de Procedimientos Familiares del Estado de Chihuahua y el artículo 27 de la Ley del Impuesto sobre la Renta y el artículo 2273 del Código Civil para el Estado Libre y Soberano de Puebla";
    const c = citasEnProsa(t, indice);
    expect(c.map((x) => x.cita)).toEqual(["ART. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH", "ART. 27 LISR", "ART. 2273 PUE-C-CIVIL-PUEBLA"]);
    for (const x of c) {
      expect(t.slice(x.inicio, x.fin)).toBe(x.textoEnRespuesta);
      expect(x.textoEnRespuesta).not.toContain(" y el artículo");
    }
  });
});
