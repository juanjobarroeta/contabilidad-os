import { describe, it, expect } from "vitest";
import { interpretarOpinionSat, sentidoSat, folioSat, fechaEmisionSat, motivosSat, cadenaOriginalSat } from "./sat-opinion";

// Texto REAL extraído del PDF (BARTIZ, 22-sep-2026): tabla con encabezados y
// valores en renglones distintos, y la cadena original firmada al final.
const REAL = `Opinión del cumplimiento de obligaciones fiscales
Nombre, denominación o razón social Sentido
CONSTRUCTORA BARTIZ-VERT SA DE CV POSITIVO
RFC Folio
CBA170606FQ8 26NL1324942
Fecha y hora de emisión
22 de septiembre de 2026 a las 12:52 horas
Apreciable contribuyente
Se le informa que en los controles electrónicos institucionales del Servicio de Administración Tributaria, se observa que al momento en que
se realiza esta revisión, se encuentra al corriente en los puntos que revisa la opinión del cumplimiento de obligaciones fiscales, contenidos
en la Resolución Miscelánea Fiscal vigente; la presente opinión no es una constancia del correcto entero de los impuestos declarados,
Artículos: 17-D, 32-D del CFF; Reglas 2.1.27., 2.1.28., 2.1.36. y 2.1.37. de la RMF.
Cadena Original
||CBA170606FQ8|26NL1324942|22-09-2026|P||00001088888800000031||
Sello Digital
Enj96MR8kj0fqYzgPqMUwpCChlzMdea8RrWerdbuJxzUmKrb5ziE06Uk7tu6Brh+RLz9hfMar+sMaLvmgmVMPsrOZ
`;

const POSITIVA = `
SERVICIO DE ADMINISTRACIÓN TRIBUTARIA
OPINIÓN DEL CUMPLIMIENTO DE OBLIGACIONES FISCALES
Folio: 26NE7654321
RFC: CBA170606FQ8
Denominación o razón social: CONSTRUCTORA BARTIZ-VERT SA DE CV
Fecha de emisión: 22 de septiembre de 2026
Sentido: POSITIVO
Con base en la información que obra en los sistemas institucionales, se emite la presente opinión en sentido POSITIVO,
toda vez que el contribuyente se encuentra al corriente en el cumplimiento de sus obligaciones fiscales.
La presente opinión tiene una vigencia de 30 días naturales.
`;

const NEGATIVA = `
OPINIÓN DEL CUMPLIMIENTO DE OBLIGACIONES FISCALES
Folio 26NE0001111
Fecha: 05/09/2026
Sentido de la opinión: NEGATIVO
El contribuyente NO se encuentra al corriente en el cumplimiento de sus obligaciones fiscales.
DETALLE
Obligaciones omitidas:
Declaración provisional mensual de ISR personas morales, periodo Julio 2026
Declaración mensual de IVA, periodo Julio 2026
Créditos fiscales firmes: ninguno
Para efectos del artículo 32-D del CFF.
`;

const SIN_OBLIG = `
OPINIÓN DEL CUMPLIMIENTO
Folio: 26NE2222222
Fecha de emisión: 1 de septiembre de 2026
Sentido: INSCRITO SIN OBLIGACIONES
`;

describe("interpretarOpinionSat", () => {
  it("PDF real: folio y fecha de la cadena original, no el RFC", () => {
    expect(cadenaOriginalSat(REAL)).toEqual({ rfc: "CBA170606FQ8", folio: "26NL1324942", fecha: "2026-09-22", sentido: "P" });
    const r = interpretarOpinionSat(REAL, new Date("2026-09-23T00:00:00Z"));
    expect(r.resultado).toBe("POSITIVA");
    expect(r.motivos).toEqual(["Folio SAT: 26NL1324942"]);
    expect(r.vigencia).toBe("2026-10-22");
    // Sin la cadena (PDF recortado): la forma del folio sigue ganando al RFC.
    const sinCadena = REAL.split("Cadena Original")[0];
    expect(folioSat(sinCadena)).toBe("26NL1324942");
    expect(fechaEmisionSat(sinCadena)).toBe("2026-09-22");
    expect(sentidoSat(sinCadena)).toBe("POSITIVA");
  });

  it("cadena original N → NEGATIVA aunque el cuerpo no se lea", () => {
    expect(sentidoSat("||ABC010101AAA|26NL0000001|01-09-2026|N||0001||")).toBe("NEGATIVA");
  });

  it("positiva: sentido, folio, vigencia 30 días desde la emisión", () => {
    const r = interpretarOpinionSat(POSITIVA, new Date("2026-09-23T00:00:00Z"));
    expect(r.tipo).toBe("SAT_OPINION");
    expect(r.resultado).toBe("POSITIVA");
    expect(r.motivos[0]).toBe("Folio SAT: 26NE7654321");
    expect(r.vigencia).toBe("2026-10-22");
  });

  it("negativa: lista las obligaciones omitidas, no el boilerplate", () => {
    const r = interpretarOpinionSat(NEGATIVA);
    expect(r.resultado).toBe("NEGATIVA");
    expect(r.motivos[0]).toBe("Folio SAT: 26NE0001111");
    expect(r.motivos.some((m) => /ISR personas morales, periodo Julio 2026/.test(m))).toBe(true);
    expect(r.motivos.some((m) => /IVA, periodo Julio 2026/.test(m))).toBe(true);
    expect(r.motivos.some((m) => /32-D/.test(m))).toBe(false);
    expect(r.vigencia).toBe("2026-10-05");
  });

  it("inscrito sin obligaciones", () => {
    expect(sentidoSat(SIN_OBLIG)).toBe("SIN_OBLIGACIONES");
    expect(fechaEmisionSat(SIN_OBLIG)).toBe("2026-09-01");
  });

  it("cadena original manda sobre el cuerpo", () => {
    const t = "||RFC:X|Folio:26NE99|Sentido:NEGATIVO|| se encuentra al corriente";
    expect(sentidoSat(t)).toBe("NEGATIVA");
    expect(folioSat(t)).toBe("26NE99");
  });

  it("sin nada reconocible → ERROR con aviso, sin inventar", () => {
    const r = interpretarOpinionSat("documento vacío");
    expect(r.resultado).toBe("ERROR");
    expect(r.motivos.some((m) => /No se pudo interpretar/.test(m))).toBe(true);
  });

  it("motivos: deduplica y acota", () => {
    const rep = Array(15).fill("Declaración mensual de IVA, periodo Julio 2026").join("\n");
    expect(motivosSat(rep)).toHaveLength(1);
  });
});
