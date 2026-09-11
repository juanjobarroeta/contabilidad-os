import { describe, expect, it } from "vitest";
import {
  chunkTesis,
  citaTesis,
  claveTesis,
  epocaCorta,
  estadoCriterioDe,
  fechasDe,
  materiasDeTesis,
  normalizarTesis,
  tipoCriterioDe,
  type TesisSjf,
} from "./normalizar";

/** Tesis real del API (GET …/api/v1/tesis/2031002), recortada en el texto. */
const T2031002: TesisSjf = {
  idTesis: 2031002,
  rubro: "DERECHO DE ACCESO A LA JUSTICIA. LOS COLEGIOS DE ABOGADOS SON SUJETOS IDÓNEOS PARA SU PROMOCIÓN Y PROTECCIÓN A NIVEL COLECTIVO, EN TANTO EL ACCESO A LA JUSTICIA SE CONFIGURA COMO UN BIEN PÚBLICO.",
  texto: "Hechos: Un colegio de abogados promovió un juicio de amparo indirecto en contra del Congreso de la Unión…\r\n\r\nCriterio jurídico: La Primera Sala determina que los colegios de abogados son actores fundamentales…\r\n\r\nJustificación: El derecho de acceso a la justicia tiene una importancia dual…",
  precedentes: "Amparo en revisión 265/2020. 12 de mayo de 2021. Cinco votos…\r\n\r\nTesis de jurisprudencia 215/2025 (11a.). Aprobada por la Primera Sala…",
  epoca: "Undécima Época",
  instancia: "Suprema Corte de Justicia de la Nación",
  organoJuris: "Primera Sala",
  fuente: "Gaceta del Semanario Judicial de la Federación",
  tesis: "1a./J. 215/2025 (11a.)",
  tipoTesis: "Jurisprudencia",
  localizacion: " [J]; 11a. Época; 1a. Sala; Gaceta S.J.F.; Libro 52, Agosto de 2025; Tomo IV, Volumen 1; Pág. 424",
  anio: 2025,
  mes: "Agosto",
  notaPublica: "Esta tesis se publicó el viernes 22 de agosto de 2025 a las 10:30 horas en el Semanario Judicial de la Federación y, por ende, se considera de aplicación obligatoria a partir del lunes 25 de agosto de 2025, para los efectos previstos en el punto noveno del Acuerdo General Plenario 1/2021.",
  anexos: "",
  huellaDigital: "71057645ff7a6f14e9688cc96f8ba2d176fd6c5bc7b135aff9945d3d700ce096",
  materias: ["Civil", "Constitucional"],
};

const T12A: TesisSjf = {
  ...T2031002,
  idTesis: 2032635,
  rubro: "TRANSPORTE PARA EL ESTADO DE BAJA CALIFORNIA SUR. LOS ARTÍCULOS 6o., 47, 47 BIS Y 47 TER DEL REGLAMENTO…",
  epoca: "Duodécima Época",
  instancia: "Tribunales Colegiados de Circuito",
  organoJuris: "SEGUNDO TRIBUNAL COLEGIADO DEL VIGÉSIMO SEXTO CIRCUITO.",
  tesis: "XXVI.2o. J/1 A (12a.)",
  tipoTesis: "Jurisprudencia",
  anio: 2026,
  mes: "Septiembre",
  notaPublica: "Esta tesis se publicó el viernes 11 de septiembre de 2026 a las 10: 20 horas en el Semanario Judicial de la Federación y, por ende, se considera de aplicación obligatoria a partir del día hábil siguiente, 17 de septiembre de 2026, para los efectos previstos en el punto octavo del Acuerdo General Plenario 7/2025 (12a.).",
  huellaDigital: "290a44eedb545d6afd5d28bb4a935912bebeb2ce74e61fb5326fa9137ee303a5",
  materias: ["Administrativa", "Común"],
};

describe("épocas, tipo y cita", () => {
  it("abrevia la Época como la citan los abogados", () => {
    expect(epocaCorta("Undécima Época")).toBe("11a.");
    expect(epocaCorta("Duodécima Época")).toBe("12a.");
    expect(epocaCorta("Quinta Época")).toBe("5a.");
    expect(epocaCorta("9a. Época")).toBe("9a.");
    expect(epocaCorta("")).toBeNull();
  });
  it("jurisprudencia vs aislada", () => {
    expect(tipoCriterioDe("Jurisprudencia")).toBe("JURISPRUDENCIA");
    expect(tipoCriterioDe("Tesis Aislada")).toBe("AISLADA");
    expect(tipoCriterioDe(undefined)).toBe("AISLADA");
  });
  it("la cita lleva número y registro", () => {
    expect(citaTesis("JURISPRUDENCIA", "1a./J. 215/2025 (11a.)", "2031002")).toBe("Jurisprudencia 1a./J. 215/2025 (11a.), reg. 2031002");
    expect(citaTesis("AISLADA", null, "2031002")).toBe("Tesis aislada reg. 2031002");
    expect(claveTesis(2031002)).toBe("SJF-2031002");
  });
});

describe("fechas de la nota de publicación", () => {
  it("publicación y obligatoriedad de una tesis de la 11a.", () => {
    const f = fechasDe(T2031002);
    expect(f.publicacion?.toISOString().slice(0, 10)).toBe("2025-08-22");
    expect(f.obligatoria?.toISOString().slice(0, 10)).toBe("2025-08-25");
  });
  it("«a partir del día hábil siguiente, 17 de septiembre de 2026» (12a.)", () => {
    const f = fechasDe(T12A);
    expect(f.publicacion?.toISOString().slice(0, 10)).toBe("2026-09-11");
    expect(f.obligatoria?.toISOString().slice(0, 10)).toBe("2026-09-17");
  });
  it("sin nota (Épocas viejas) cae al primer día del mes/año", () => {
    const f = fechasDe({ notaPublica: "", anio: 1998, mes: "Marzo" });
    expect(f.publicacion).toBeNull();
    expect(f.obligatoria).toBeNull();
    expect(f.respaldo.toISOString().slice(0, 10)).toBe("1998-03-01");
  });
});

describe("materias y estado del criterio", () => {
  it("traduce las materias del SJF y detecta lo fiscal en «Administrativa»", () => {
    expect(materiasDeTesis(["Civil", "Constitucional"], "DERECHO DE ACCESO A LA JUSTICIA…")).toEqual(["civil", "constitucional"]);
    expect(materiasDeTesis(["Administrativa"], "IMPUESTO SOBRE LA RENTA. DEDUCCIÓN DE GASTOS…")).toEqual(["administrativo", "fiscal"]);
    expect(materiasDeTesis(["Administrativa", "Común"], "TRANSPORTE PARA EL ESTADO…")).toEqual(["administrativo", "amparo", "procesal"]);
    expect(materiasDeTesis(["Laboral"], "SEGURO SOCIAL. CUOTAS OBRERO PATRONALES…")).toEqual(["laboral", "seguridad_social"]);
    expect(materiasDeTesis([], "algo")).toEqual(["administrativo"]);
  });
  it("interrumpida / superada / sustituida se leen de las notas; «sustituye a» no cuenta", () => {
    expect(estadoCriterioDe({ notaPublica: "Esta tesis se interrumpió por la diversa…", precedentes: "", texto: "" })).toBe("INTERRUMPIDA");
    expect(estadoCriterioDe({ notaPublica: "", precedentes: "Esta tesis fue superada por contradicción de criterios 12/2020…", texto: "" })).toBe("SUPERADA");
    expect(estadoCriterioDe({ notaPublica: "Esta tesis ha sido sustituida por la diversa 2a./J. 3/2021", precedentes: "", texto: "" })).toBe("SUSTITUIDA");
    expect(estadoCriterioDe({ notaPublica: "Esta tesis sustituye a la diversa 2a./J. 1/2019", precedentes: "", texto: "" })).toBe("VIGENTE");
    expect(estadoCriterioDe(T2031002)).toBe("VIGENTE");
  });
});

describe("chunks y normalización completa", () => {
  it("una tesis corta es un solo chunk con rubro, texto y precedentes", () => {
    const ch = chunkTesis(T2031002, "Jurisprudencia 1a./J. 215/2025 (11a.), reg. 2031002");
    expect(ch).toHaveLength(1);
    expect(ch[0].parte).toBeNull();
    expect(ch[0].texto.startsWith("[Jurisprudencia 1a./J. 215/2025 (11a.), reg. 2031002]\nDERECHO DE ACCESO")).toBe(true);
    expect(ch[0].texto).toContain("Criterio jurídico");
    expect(ch[0].texto).toContain("Precedentes: Amparo en revisión 265/2020");
    expect(ch[0].texto).not.toContain("\r");
  });
  it("una tesis larga se parte por párrafos, cada parte con el rubro, precedentes al final", () => {
    const larga = { ...T2031002, texto: Array.from({ length: 12 }, (_, i) => `Párrafo ${i} ${"x".repeat(900)}`).join("\n\n") };
    const ch = chunkTesis(larga, "cita");
    expect(ch.length).toBeGreaterThan(1);
    for (const c of ch) {
      expect(c.texto.startsWith("[cita]\nDERECHO DE ACCESO")).toBe(true);
      expect(c.texto.length).toBeLessThanOrEqual(6200);
    }
    expect(ch[1].texto).toContain("[… continúa]");
    expect(ch.at(-1)!.texto).toContain("Precedentes:");
    expect(ch[0].texto).not.toContain("Precedentes:");
  });
  it("normalizarTesis: lo que va a FiscalDocument", () => {
    const n = normalizarTesis(T2031002);
    expect(n.clave).toBe("SJF-2031002");
    expect(n.registro).toBe("2031002");
    expect(n.numeroTesis).toBe("1a./J. 215/2025 (11a.)");
    expect(n.epoca).toBe("11a.");
    expect(n.instancia).toBe("Suprema Corte de Justicia de la Nación");
    expect(n.organo).toBe("Primera Sala");
    expect(n.tipoCriterio).toBe("JURISPRUDENCIA");
    expect(n.estadoCriterio).toBe("VIGENTE");
    expect(n.fechaPublicacion?.toISOString().slice(0, 10)).toBe("2025-08-22");
    expect(n.vigenciaDesde.toISOString().slice(0, 10)).toBe("2025-08-25");
    expect(n.hash).toBe(T2031002.huellaDigital);
    expect(n.materias).toEqual(["civil", "constitucional"]);
    expect(n.contexto).toBe("11a. Época · Suprema Corte de Justicia de la Nación · Primera Sala");
    expect(n.url).toBe("https://sjf2.scjn.gob.mx/detalle/tesis/2031002");
    expect(n.chunks).toHaveLength(1);
  });
  it("el órgano de un colegiado pierde el punto final; la 12a. obliga desde el 17 de septiembre", () => {
    const n = normalizarTesis(T12A);
    expect(n.organo).toBe("SEGUNDO TRIBUNAL COLEGIADO DEL VIGÉSIMO SEXTO CIRCUITO");
    expect(n.epoca).toBe("12a.");
    expect(n.vigenciaDesde.toISOString().slice(0, 10)).toBe("2026-09-17");
    expect(n.materias).toEqual(["administrativo", "amparo", "procesal"]);
  });
});
