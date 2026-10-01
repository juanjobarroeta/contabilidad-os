import { describe, expect, it } from "vitest";
import { chunkLaw, cleanLawText, corregirNotasPegadas, chunkRegla, chunkDocument } from "./chunk";

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

describe("chunkLaw — encabezados con tabuladores (Chihuahua, Querétaro, Sonora)", () => {
  it("«ARTÍCULO \t479. \tLos autos…» es un encabezado; cada artículo sale en su chunk", () => {
    const raw = [
      "CÓDIGO DE PROCEDIMIENTOS FAMILIARES DEL ESTADO DE CHIHUAHUA",
      "CAPÍTULO \tII",
      "REVOCACIÓN",
      "ARTÍCULO \t479. \tLos \tautos \tdictados \ten \taudiencia \to \tfuera \tde \tella \ty \tque \tno \tfueren \tapelables, \tson",
      "revocables por el tribunal que los haya dictado.",
      "ARTÍCULO \t480. Durante la audiencia, el recurso de revocación solo procede en contra del auto",
      "que:",
      "I. \tNo admita una prueba.",
      "ARTÍCULO 486. \tLa apelación solo procede en efecto devolutivo, con excepción de las salvedades",
      "previstas en este código.",
    ].join("\n");
    const chunks = chunkLaw(cleanLawText(raw));
    expect(chunks.map((c) => c.articulo)).toEqual(["479", "480", "486"]);
    expect(chunks[0].texto).toContain("ARTÍCULO 479. Los autos dictados en audiencia");
    expect(chunks[0].texto).not.toContain("\t");
    expect(chunks[1].texto).toContain("I. No admita una prueba.");
  });
});

// La RMF 2026 traía 1 112 reglas y sólo entraron 258: el patrón exigía cuatro
// niveles de numeración y los títulos sin sección numeran a tres. Faltaba TODO
// el IVA y TODO el IEPS, con el documento marcado como cargado.
describe("chunkRegla: la RMF no numera todo igual", () => {
  const rmf = [
    "Título 2. Código Fiscal de la Federación",
    "Capítulo 2.6. De los controles volumétricos",
    "2.6.1.1. Para los efectos del artículo 28, fracción I, los contribuyentes deberán llevar controles.",
    "2.6.1.2. Para los efectos del artículo 28, fracción I, apartado B, se entenderá por equipo.",
    "Título 4. Impuesto al valor agregado",
    "Capítulo 4.1. Disposiciones generales",
    "4.1.1. Para los efectos del artículo 1o.-A, fracción II, inciso b) de la Ley del IVA, la retención.",
    "4.2.2. La enajenación de billetes y demás comprobantes que permitan participar en loterías.",
    "Título 5. Impuesto especial sobre producción y servicios",
    "5.2.27. Los productores e importadores de tabacos labrados deberán informar trimestralmente.",
    "12.1.1. Para los efectos del artículo 18-B de la Ley del IVA, los servicios digitales.",
  ].join("\n");

  it("toma las reglas de tres niveles, no sólo las de cuatro", () => {
    const reglas = chunkRegla(rmf).map((c) => c.articulo);
    expect(reglas).toContain("2.6.1.1"); // cuatro niveles
    expect(reglas).toContain("4.1.1"); // IVA, tres niveles
    expect(reglas).toContain("5.2.27"); // IEPS, tres niveles
    expect(reglas).toContain("12.1.1"); // servicios digitales
  });

  it("no confunde un capítulo con una regla", () => {
    // «Capítulo 4.1.» lleva la palabra delante; «4.1.1.» empieza con el número.
    const reglas = chunkRegla(rmf).map((c) => c.articulo);
    expect(reglas).not.toContain("4.1");
    expect(reglas).not.toContain("2.6");
  });

  it("el capítulo alimenta la miga de pan de sus reglas", () => {
    const iva = chunkRegla(rmf).find((c) => c.articulo === "4.1.1");
    expect(iva?.contexto).toMatch(/Cap[íi]tulo 4\.1/);
  });

  it("cada regla se queda con su propio texto", () => {
    const c = chunkRegla(rmf).find((x) => x.articulo === "4.2.2");
    expect(c?.texto).toContain("billetes");
    expect(c?.texto).not.toContain("tabacos labrados");
  });
});

describe("chunkCriterio (Anexos 3 y 7 de la RMF)", () => {
  const indice = ["Contenido", "Criterios del CFF", "1/CFF/N", "Crédito fiscal. Es firme.", "2/CFF/N", "Normas sustantivas.", "3/CFF/N", "Momento de causación.", "4/CFF/N", "Actualización.", "5/CFF/N", "Recargos.", "1/ISR/PI", "Deducción indebida."].join("\n");
  const cuerpo = (clave: string, titulo: string) =>
    `${clave}\n\n${titulo} Texto largo del criterio con su fundamento: el artículo 17-A del CFF establece que el monto de las contribuciones se actualiza por el transcurso del tiempo y con motivo de los cambios de precios en el país.\n`;
  const texto = [
    indice,
    "Criterios del CFF",
    cuerpo("1/CFF/N", "Crédito fiscal. Es firme."),
    cuerpo("2/CFF/N", "Normas sustantivas."),
    cuerpo("3/CFF/N", "Momento de causación."),
    cuerpo("4/CFF/N", "Actualización."),
    cuerpo("5/CFF/N", "Recargos."),
    "Criterios de la Ley del ISR",
    cuerpo("1/ISR/PI", "Deducción indebida."),
  ].join("\n");

  it("una pieza por criterio, con el cuerpo (no la entrada del índice)", () => {
    const c = chunkDocument(texto, "criterio");
    expect(c.map((x) => x.articulo)).toEqual(["1/CFF/N", "2/CFF/N", "3/CFF/N", "4/CFF/N", "5/CFF/N", "1/ISR/PI"]);
    expect(c[0].texto).toContain("artículo 17-A del CFF");
    expect(c[5].contexto).toBe("Criterios de la Ley del ISR");
  });
});

describe("chunkTramite (Anexo 2 de la RMF)", () => {
  const ficha = (clave: string, titulo: string) =>
    `${clave} ${titulo}\n\nTrámite\nDescripción del trámite o servicio\n¿Quién puede solicitar el trámite o servicio?\nPersonas morales.\n¿Cuándo se presenta?\nDentro del mes siguiente. Fundamento jurídico: artículos 27 del CFF y 29 de su Reglamento.\n`;
  const texto = [
    "Contenido",
    "1/CFF",
    "Solicitud de inscripción en el RFC de personas físicas.",
    "2/CFF",
    "Solicitud de inscripción en el RFC de personas morales.",
    "Código Fiscal de la Federación",
    ficha("1/CFF", "Solicitud de inscripción en el RFC de personas físicas."),
    "Ver el trámite 2/CFF más adelante.",
    ficha("2/CFF", "Solicitud de inscripción en el RFC de personas morales."),
    ficha("3/CFF", "Solicitud de inscripción en el RFC por oficina virtual."),
    "Impuesto sobre la Renta",
    ficha("1/ISR", "Aviso de opción para tributar."),
    "Del Decreto por el que se otorgan diversos beneficios fiscales",
    ficha("1/DEC-1", "Aviso para aplicar el estímulo."),
  ].join("\n");

  it("una pieza por ficha, con la ley de su sección; ignora el índice y menciones a media línea", () => {
    const c = chunkDocument(texto, "tramite");
    expect(c.map((x) => x.articulo)).toEqual(["1/CFF", "2/CFF", "3/CFF", "1/ISR", "1/DEC-1"]);
    expect(c[0].texto).toContain("¿Cuándo se presenta?");
    expect(c[0].contexto).toBe("Código Fiscal de la Federación");
    expect(c[3].contexto).toBe("Impuesto sobre la Renta");
    expect(c[4].contexto).toMatch(/^Del Decreto/);
  });
});
