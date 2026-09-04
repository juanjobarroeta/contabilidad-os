import { describe, expect, it } from "vitest";
import { chunkLaw, cleanLawText, corregirNotasPegadas } from "./chunk";

const ley = (cuerpo: string) => `LEY DE PRUEBA\n\nTÍTULO I\nDISPOSICIONES GENERALES\n${cuerpo}\n`;

describe("chunkLaw — encabezados de artículo", () => {
  it("LISR: «Artículo 113-E.» y «Artículo 5.»", () => {
    const chunks = chunkLaw(ley("Artículo 5. Texto cinco.\nArtículo 113-E. Texto resico."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5", "113-E"]);
  });
  it("LIVA/CFF: el ordinal «5o.-» se conserva; «1o.-A.-» se cita «1o-A»; «17-H Bis.» entero", () => {
    const chunks = chunkLaw(ley("Artículo 5o.- Texto.\nArtículo 1o.-A.- Texto.\nArtículo 1o.-B.- Texto.\nArtículo 17-H Bis. Texto.\nArtículo 32-Bis. Texto."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5o", "1o-A", "1o-B", "17-H Bis", "32-Bis"]);
  });
  it("LSS/LFT: «Artículo 5 A.» se cita «5-A»", () => {
    const chunks = chunkLaw(ley("Artículo 5. Texto.\nArtículo 5 A. Texto cinco A.\nArtículo 15 B. Texto."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5", "5-A", "15-B"]);
  });
  it("no confunde una referencia en prosa con un encabezado", () => {
    const chunks = chunkLaw(ley("Artículo 5. Ver el Artículo 6 de esta Ley para más.\nArtículo 6. Texto."));
    expect(chunks.map((c) => c.articulo)).toEqual(["5", "6"]);
  });
});

describe("chunkLaw — artículos largos se parten por fracciones", () => {
  const fraccion = (n: string) => `${n}. ${"Requisito de la fracción " + n + ". "}${"texto ".repeat(150)}`;
  const romanos = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

  it("cada parte arranca en una fracción, cabe en el tamaño objetivo y repite el encabezado", () => {
    const cuerpo = `Artículo 27. Las deducciones autorizadas deberán reunir los siguientes requisitos:\n${romanos.map(fraccion).join("\n")}\nArtículo 28. No serán deducibles:\nI. Corto.`;
    const chunks = chunkLaw(ley(cuerpo));
    const a27 = chunks.filter((c) => c.articulo === "27");
    expect(a27.length).toBeGreaterThan(2);
    expect(a27.map((c) => c.parte)).toEqual(a27.map((_, i) => i + 1));
    for (const [i, c] of a27.entries()) {
      const sinBreadcrumb = c.texto.replace(/^\[[^\]]*\]\n/, "");
      const lineas = sinBreadcrumb.split("\n");
      if (i === 0) {
        expect(lineas[0]).toMatch(/^Artículo 27\. Las deducciones/);
      } else {
        expect(lineas[0]).toBe("Artículo 27. Las deducciones autorizadas deberán reunir los siguientes requisitos: (continúa)");
        expect(lineas[1]).toMatch(/^[IVX]+\. /);
      }
      expect(sinBreadcrumb.length).toBeLessThanOrEqual(3200);
    }
    // Ninguna fracción se perdió ni se duplicó entre partes.
    const arranques = a27.flatMap((c) => c.texto.split("\n").filter((l) => /^[IVX]+\. Requisito/.test(l)));
    expect(arranques).toHaveLength(romanos.length);
    expect(chunks.filter((c) => c.articulo === "28")).toHaveLength(1);
  });

  it("un artículo largo SIN fracciones se sigue partiendo por tamaño", () => {
    const cuerpo = `Artículo 9. Prosa larga.\n${"Renglón de prosa sin fracciones, como un artículo narrativo largo.\n".repeat(200)}Artículo 10. Corto.`;
    const chunks = chunkLaw(ley(cuerpo));
    const a9 = chunks.filter((c) => c.articulo === "9");
    expect(a9.length).toBeGreaterThan(1);
    expect(a9[1].texto).not.toContain("(continúa)");
  });
});

describe("chunkLaw — la cola de la ley no se la traga el último artículo", () => {
  it("«DISPOSICIONES TRANSITORIAS DE LA LEY…» corta igual que «TRANSITORIOS»", () => {
    const cuerpo = [
      "Artículo 214. Texto.",
      "Artículo 215. Las personas morales aplicarán lo dispuesto en el artículo 12 cuando entren en liquidación.",
      "DISPOSICIONES DE VIGENCIA TEMPORAL DE LA LEY DEL IMPUESTO SOBRE LA",
      "RENTA",
      "ARTÍCULO OCTAVO. Durante 2014 los intereses podrán estar sujetos a una tasa del 4.9 por ciento.",
      "DISPOSICIONES TRANSITORIAS DE LA LEY DEL IMPUESTO SOBRE LA RENTA",
      "ARTÍCULO NOVENO. En relación con la Ley se estará a lo siguiente:",
      "I. La Ley entrará en vigor el 1 de enero de 2014.",
      "TRANSITORIOS",
      "Primero. El presente Decreto entrará en vigor el 1 de enero de 2014.",
      "ARTÍCULOS TRANSITORIOS DE DECRETOS DE REFORMA",
      "DECRETO por el que se reforman diversas disposiciones.",
    ].join("\n");
    const chunks = chunkLaw(ley(cuerpo));
    const a215 = chunks.filter((c) => c.articulo === "215");
    expect(a215).toHaveLength(1);
    expect(a215[0].texto).not.toContain("VIGENCIA TEMPORAL");
    const cola = chunks.filter((c) => c.articulo === "TRANSITORIOS");
    expect(cola.length).toBeGreaterThanOrEqual(1);
    expect(cola.map((c) => c.texto).join("\n")).toContain("ARTÍCULO OCTAVO");
    expect(cola.map((c) => c.texto).join("\n")).toContain("DECRETO por el que se reforman");
  });
});

describe("chunkLaw — encabezados en mayúsculas (códigos estatales, facsímiles del DOF)", () => {
  it("«ARTÍCULO 1.», «ARTICULO 158.-» y «ARTÍCULO 11» a fin de línea son encabezados; «ARTÍCULO 30 BIS» se cita «30 Bis»", () => {
    const texto = [
      "ARTÍCULO 1. El presente ordenamiento es de observancia general.",
      "ARTICULO 158.- El Impuesto sobre Nóminas se determinará aplicando la tasa del 4%.",
      "ARTÍCULO 11",
      "Están obligados al pago del impuesto sobre erogaciones las personas que realicen pagos por trabajo personal.",
      "ARTÍCULO 30 BIS",
      "Los contribuyentes presentarán la declaración en los formatos autorizados por la Secretaría.",
    ].join("\n");
    const arts = chunkLaw(texto).map((c) => c.articulo);
    expect(arts).toEqual(["1", "158", "11", "30 Bis"]);
    // Orden Jurídico Poblano (Código Fiscal de Puebla): «Artículo 129» solo en su renglón.
    expect(chunkLaw("Artículo 129\nEl recurso de revocación procede contra resoluciones definitivas.\nArtículo 129-A\nEl plazo para interponerlo es de treinta días.").map((c) => c.articulo)).toEqual(["129", "129-A"]);
  });
  it("una referencia en mayúsculas dentro de una frase no es encabezado", () => {
    const texto = "ARTÍCULO 5. Para los efectos de este Código se estará a lo siguiente:\nARTÍCULO 5 de la Ley de Ingresos fija la tasa aplicable cada año.\nARTÍCULO 6. Otra cosa.";
    expect(chunkLaw(texto).map((c) => c.articulo)).toEqual(["5", "6"]);
  });
  it("sinIndice quita una corrida de entradas de índice y respeta artículos derogados cortos", () => {
    const indice = Array.from({ length: 10 }, (_, i) => `ARTÍCULO ${i + 1}`).join("\n");
    const cuerpo = Array.from({ length: 10 }, (_, i) => `ARTÍCULO ${i + 1}. Texto real del artículo número ${i + 1} con suficiente contenido para no parecer índice; obliga y regula.`).join("\n");
    const derogados = Array.from({ length: 9 }, (_, i) => `Artículo ${i + 20}. (Se deroga).`).join("\n");
    const arts = chunkLaw(`${indice}\n${cuerpo}\n${derogados}`).map((c) => c.articulo);
    expect(arts.filter((a) => a === "3")).toHaveLength(1);
    expect(arts).toContain("20");
    expect(arts).toHaveLength(19);
  });
  it("cleanLawText quita los encabezados del Orden Jurídico Poblano, los saltos de página de pdf-parse y el índice con puntos guía", () => {
    const raw = [
      "Ley de Hacienda para el Estado Libre y Soberano de Puebla",
      "Gobierno del Estado de Puebla",
      "Secretaría de Gobernación",
      "Orden Jurídico Poblano",
      "ARTÍCULO 11 ....................................................................... 11",
      "-- 3 of 59 --",
      "Ley de Hacienda para el Estado Libre y Soberano de Puebla",
      "3",
      "ARTÍCULO 11",
      "Están obligados al pago del impuesto.",
    ].join("\n");
    expect(cleanLawText(raw).split("\n")).toEqual(["Ley de Hacienda para el Estado Libre y Soberano de Puebla", "ARTÍCULO 11", "Están obligados al pago del impuesto."]);
  });
});

describe("corregirNotasPegadas — notas al pie pegadas al número (Orden Jurídico Poblano)", () => {
  it("«27» tras «1» es el 2; «515» tras «4» es el 5; «139608» tras «138» es el 139; los saltos reales se respetan", () => {
    const u = (a: string) => ({ articulo: a });
    expect(corregirNotasPegadas([u("1"), u("27"), u("3"), u("4"), u("515"), u("616"), u("7")]).map((x) => x.articulo)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(corregirNotasPegadas([u("138"), u("139608"), u("140614")]).map((x) => x.articulo)).toEqual(["138", "139", "140"]);
    expect(corregirNotasPegadas([u("12"), u("14"), u("14-A"), u("15")]).map((x) => x.articulo)).toEqual(["12", "14", "14-A", "15"]);
    expect(corregirNotasPegadas([u("1"), u("10")]).map((x) => x.articulo)).toEqual(["1", "10"]);
  });
});
