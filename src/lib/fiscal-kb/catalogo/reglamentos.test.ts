import { describe, expect, it } from "vitest";
import { claveReglamento, construirCatalogoReglamentos, parsearIndiceReglamentos } from "./reglamentos";
import reglamentos from "./reglamentos-federales.json";
import { esMateria } from "../materias";

const FILA = (num: string, titulo: string, fechas: string, pdf: string) =>
  `<tr><td>${num}</td><td>${titulo}</td><td>${fechas}</td><td><a href="regley/${pdf}.pdf">PDF</a> <a href="regley/${pdf}.doc">WORD</a></td></tr>`;
const HTML = [
  FILA("36", "REGLAMENTO de la Ley de Obras P&uacute;blicas y Servicios Relacionados con las Mismas", "Original DOF 28/07/2010 Reformas DOF 06/09/2012 , 12/03/2021", "Reg_LOPSRM"),
  FILA("46", "REGLAMENTO de la Ley del Impuesto sobre la Renta", "Original DOF 08/10/2015 Reforma DOF 06/05/2016 08/10/2015", "Reg_LISR_060516"),
  FILA("A", "REGLAMENTO de la Ley de Hidrocarburos Reglamento Abrogado", "03/10/2025", "Reg_LHidro"),
  `<tr><td>x</td><td><a href="regley/Reg_LAdua_orig_20abr15.pdf">orig</a><a href="regley/Reg_LAdua_ref01.pdf">ref</a></td></tr>`,
].join("\n");

describe("parsearIndiceReglamentos", () => {
  const filas = parsearIndiceReglamentos(HTML);
  it("una fila por PDF vigente; abrogados y decretos sueltos fuera", () => {
    expect(filas.map((f) => f.archivo)).toEqual(["Reg_LOPSRM", "Reg_LISR_060516"]);
  });
  it("la última reforma es la fecha más reciente, aunque la fila repita la original al final", () => {
    expect(filas[0]).toMatchObject({ dofOriginal: "2010-07-28", ultimaReforma: "2021-03-12" });
    expect(filas[1]).toMatchObject({ dofOriginal: "2015-10-08", ultimaReforma: "2016-05-06" });
  });
});

describe("claves y catálogo", () => {
  it("los reglamentos que ya vivían en la base conservan su clave; el resto lleva R-", () => {
    expect(claveReglamento("Reg_LISR_060516")).toBe("RLISR");
    expect(claveReglamento("Reg_CFF")).toBe("RCFF");
    expect(claveReglamento("Reg_LOPSRM")).toBe("R-LOPSRM");
    expect(claveReglamento("Reg_LGEEPA_MEIA")).toBe("R-LGEEPA-MEIA");
  });
  it("el catálogo generado: claves únicas, materias válidas, construcción presente", () => {
    const e = reglamentos.entradas;
    expect(e.length).toBeGreaterThan(120);
    expect(new Set(e.map((x) => x.clave)).size).toBe(e.length);
    for (const x of e) for (const m of x.materias) expect(esMateria(m), `${x.clave}: ${m}`).toBe(true);
    expect(e.find((x) => x.clave === "R-LOPSRM")?.materias).toContain("construccion");
    expect(construirCatalogoReglamentos(parsearIndiceReglamentos(HTML)).map((x) => x.clave)).toEqual(["R-LOPSRM", "RLISR"]);
  });
});
