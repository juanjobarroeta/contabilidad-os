import { describe, expect, it } from "vitest";
import { CLAVE_POR_ARCHIVO, EXCLUSIONES, claveDesdeArchivo, construirCatalogo, normalizarTitulo, parsearIndice } from "./diputados";
import federal from "./federal.json";
import { MATERIAS, MATERIAS_CONTADOR, esMateria } from "../materias";

// Forma real del índice (una celda con número, otra con título+ref, otra con
// fechas, otra con los enlaces PDF/DOC). Las entidades vienen en ISO-8859-1.
const FILA = (num: string, ref: string, titulo: string, orig: string, resto: string, pdf: string) =>
  `<tr><td>${num}</td><td><a href="ref/${ref}.htm">${titulo}</a></td><td>DOF ${orig}</td><td>${resto}</td>` +
  `<td><a href="pdf/${pdf}.pdf">PDF</a> <a href="doc/${pdf}.doc">Word</a></td></tr>`;

const HTML = [
  "<table>",
  FILA("001", "cpeum", "CONSTITUCI&Oacute;N Pol&iacute;tica de los Estados Unidos Mexicanos", "05/02/1917", "Nuevas reformas DOF 02/06/2026", "CPEUM"),
  FILA("003", "ccom", "C&Oacute;DIGO de Comercio", "07/10/1889", "DOF 18/02/2026", "CCom"),
  FILA("012", "79", "IMPUESTO sobre Servicios Expresamente Declarados de Inter&eacute;s P&uacute;blico por Ley", "31/12/1968", "Sin reforma", "79"),
  FILA("098", "lsint", "LEY de Seguridad Interior", "21/12/2017", "( Declaratoria de Invalidez de la Ley DOF 30/05/2019 ) DOF 30/05/2019 Sentencia SCJN", "LSInt_300519"),
  FILA("223", "lgsmime", "LEY General del Sistema de Medios de Impugnaci&oacute;n en Materia Electoral", "22/11/1996", '( "Recupera vigencia" por Declaratoria de Invalidez DOF 24/11/2023 ) DOF 14/11/2025', "LGSMIME"),
  FILA("A", "lfc", "LEY Federal de Cinematograf&iacute;a", "29/12/1992", "Ley Abrogada DOF 22/05/2026", "LFC"),
  "<tr><td>sin pdf</td></tr>",
  "</table>",
].join("\n");

describe("parsearIndice", () => {
  const filas = parsearIndice(HTML);
  it("una fila por PDF, con título decodificado, fechas ISO y enlaces absolutos", () => {
    expect(filas.map((f) => f.archivo)).toEqual(["CPEUM", "CCom", "79", "LSInt_300519", "LGSMIME", "LFC"]);
    expect(filas[0]).toMatchObject({
      numero: "001",
      titulo: "CONSTITUCIÓN Política de los Estados Unidos Mexicanos",
      dofOriginal: "1917-02-05",
      ultimaReforma: "2026-06-02",
      urlPdf: "https://www.diputados.gob.mx/LeyesBiblio/pdf/CPEUM.pdf",
      urlRef: "https://www.diputados.gob.mx/LeyesBiblio/ref/cpeum.htm",
    });
  });
  it("«Sin reforma» → última reforma null; la abrogación no cuenta como reforma", () => {
    expect(filas[2].ultimaReforma).toBeNull();
    expect(filas[5].numero).toBe("A");
    expect(filas[5].ultimaReforma).toBeNull();
    expect(filas[5].anotaciones).toMatch(/Ley Abrogada/);
  });
  it("la última reforma es el último DOF de la fila, no el de una anotación anterior", () => {
    expect(filas[4].ultimaReforma).toBe("2025-11-14");
    expect(filas[3].anotaciones).toMatch(/Declaratoria de Invalidez/);
  });
});

describe("claveDesdeArchivo", () => {
  it("revisadas a mano primero; luego mayúsculas sin sufijo de fecha", () => {
    expect(claveDesdeArchivo("CCom")).toBe("CCOM");
    expect(claveDesdeArchivo("LIFNVT")).toBe("LINFONAVIT");
    expect(claveDesdeArchivo("79")).toBe("LISEDIP");
    expect(claveDesdeArchivo("LGSNA_200521")).toBe("LGSNA");
    expect(claveDesdeArchivo("LIF_2026")).toBe("LIF");
    expect(claveDesdeArchivo("LRArt76_fracVI")).toBe("LRART76-VI");
  });
  it("un archivo numérico sin clave revisada falla en voz alta", () => {
    expect(() => claveDesdeArchivo("999")).toThrow(/CLAVE_POR_ARCHIVO/);
  });
  it("las claves revisadas no chocan entre sí", () => {
    const valores = Object.values(CLAVE_POR_ARCHIVO);
    expect(new Set(valores).size).toBe(valores.length);
  });
});

describe("construirCatalogo", () => {
  const entradas = construirCatalogo(parsearIndice(HTML));
  it("excluye abrogadas e invalidadas con motivo, y conserva la que «recupera vigencia»", () => {
    const por = Object.fromEntries(entradas.map((e) => [e.clave, e]));
    expect(por.LFC.excluida).toMatch(/Abrogada/);
    expect(por.LSINT.excluida).toMatch(/invalidez/i);
    expect(por.LGSMIME.excluida).toBeNull();
    expect(por.CPEUM.excluida).toBeNull();
  });
  it("vigencia de respaldo = última reforma o, sin reformas, la publicación original", () => {
    const por = Object.fromEntries(entradas.map((e) => [e.clave, e]));
    expect(por.CCOM.vigenciaFallback).toBe("2026-02-18");
    expect(por.LISEDIP.vigenciaFallback).toBe("1968-12-31");
  });
  it("títulos con mayúscula inicial y materias nunca vacías", () => {
    expect(normalizarTitulo("CÓDIGO de Comercio")).toBe("Código de Comercio");
    expect(normalizarTitulo('LEY de Minería (Antes "Ley Minera" )')).toBe("Ley de Minería");
    for (const e of entradas) expect(e.materias.length).toBeGreaterThan(0);
  });
  it("una clave duplicada rompe la generación", () => {
    const filas = parsearIndice(HTML + FILA("999", "x", "LEY Duplicada", "01/01/2000", "Sin reforma", "CCom"));
    expect(() => construirCatalogo(filas)).toThrow(/duplicada/i);
  });
});

describe("catalogo/federal.json (el comprometido)", () => {
  const entradas = federal.entradas;
  it("trae los 317 ordenamientos del índice, claves únicas y todas con letras", () => {
    expect(entradas.length).toBe(317);
    const claves = entradas.map((e) => e.clave);
    expect(new Set(claves).size).toBe(claves.length);
    for (const c of claves) expect(c).toMatch(/^[A-Z][A-Z0-9-]*$/);
  });
  it("materias válidas y no vacías; exclusiones con motivo", () => {
    for (const e of entradas) {
      expect(e.materias.length).toBeGreaterThan(0);
      for (const m of e.materias) expect(esMateria(m), `${e.clave}: ${m}`).toBe(true);
      if (e.excluida !== null) expect(e.excluida.length).toBeGreaterThan(10);
    }
    for (const clave of Object.keys(EXCLUSIONES)) expect(entradas.find((e) => e.clave === clave)?.excluida).toBeTruthy();
  });
  it("las claves que ya vivían en la base conservan su clave y su materia del contador", () => {
    const por = Object.fromEntries(entradas.map((e) => [e.clave, e]));
    for (const c of ["LISR", "LIVA", "CFF", "LIEPS", "LSS", "LINFONAVIT", "LFT", "CCOM", "LGSM", "LFPIORPI", "LFDC"]) {
      expect(por[c], c).toBeDefined();
      expect(por[c].materias.some((m) => (MATERIAS_CONTADOR as readonly string[]).includes(m)), c).toBe(true);
    }
    expect(por.CPEUM.materias).toEqual(["constitucional"]);
    expect(por.LFGR.materias).not.toContain("fiscal");
  });
  it("la taxonomía no tiene materias muertas raras: cada materia del contador existe", () => {
    for (const m of MATERIAS_CONTADOR) expect(MATERIAS).toContain(m);
  });
});
