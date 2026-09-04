import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnexo5 } from "./anexo5";
import { clasificarTitulo, parseAnexo8, tarifasCoinciden } from "./anexo8";
import { parseRecargosLif, urlLif } from "./lif";
import { urlsCandidatasAnexo } from "./sat-anexos";
import { limpiarLineasDof, montoNumero, primeraFecha } from "./texto";

const fixture = (n: string) => readFileSync(join(__dirname, "__fixtures__", n), "utf8");

describe("texto", () => {
  it("limpia saltos de página, encabezados del DOF y colas de puntos", () => {
    const l = limpiarLineasDof("Artículo 82. ......................\n-- 1 of 11 --\nDomingo 28 de diciembre de 2025 DIARIO OFICIAL\n........\nI. De $2,050.00 a $25,360.00, x");
    expect(l).toEqual(["Artículo 82.", "I. De $2,050.00 a $25,360.00, x"]);
  });
  it("montos y fechas", () => {
    expect(montoNumero("$1,033,190.00")).toBe(1033190);
    expect(montoNumero("0")).toBe(0);
    expect(primeraFecha("DIARIO OFICIAL Domingo 28 de diciembre de 2025")).toBe("2025-12-28");
  });
});

describe("Anexo 5 RMF 2026 (fixture real)", () => {
  const a = parseAnexo5(fixture("anexo5-rmf-2026.txt"));
  it("cabecera: ejercicio, DOF y vigencia", () => {
    expect(a.ejercicio).toBe(2026);
    expect(a.dof).toBe("2025-12-28");
    expect(a.vigenciaDesde).toBe("2026-01-01");
  });
  it("Art. 82-I-a (no presentar declaración): $2,050 a $25,360, sección A", () => {
    const f = a.filas.find((x) => x.articulo === "82" && x.fraccion === "I" && x.inciso === "a" && x.seccion === "A");
    expect(f?.minimo).toBe(2050);
    expect(f?.maximo).toBe(25360);
    expect(f?.texto).toMatch(/declaraciones, por cada una de las obligaciones/);
  });
  it("Art. 82-I-d (no presentar en medios electrónicos): $20,790 a $41,590", () => {
    const f = a.filas.find((x) => x.articulo === "82" && x.fraccion === "I" && x.inciso === "d" && x.seccion === "A");
    expect([f?.minimo, f?.maximo]).toEqual([20790, 41590]);
  });
  it("Art. 80-III-a: 2 % con piso y tope", () => {
    const f = a.filas.find((x) => x.articulo === "80" && x.fraccion === "III" && x.inciso === "a");
    expect(f).toMatchObject({ porcentaje: 2, minimo: 4310, maximo: 10790 });
  });
  it("Art. 84-B-VII trae dos rangos en el mismo párrafo", () => {
    const fs = a.filas.filter((x) => x.articulo === "84-B" && x.fraccion === "VII");
    expect(fs.map((f) => [f.minimo, f.maximo])).toEqual([
      [140, 260],
      [516600, 1033190],
    ]);
  });
  it("umbral del Art. 32-A (dictamen) es un monto único", () => {
    const f = a.filas.find((x) => x.articulo === "32-A" && x.seccion === "A");
    expect(f).toMatchObject({ minimo: 2013710870, maximo: null, fraccion: null });
  });
  it("Art. 84-D: multa fija $630 (y $1,880 al sistema financiero)", () => {
    const fs = a.filas.filter((x) => x.articulo === "84-D");
    expect(fs.map((f) => f.minimo)).toEqual([630, 1880]);
  });
  it("la sección B (compilación) también se lee y no se mezcla con A", () => {
    const b = a.filas.filter((x) => x.seccion === "B");
    expect(b.length).toBeGreaterThan(10);
    expect(b.find((x) => x.articulo === "20")?.minimo).toBe(2761230);
  });
  it("volumen razonable y sin montos absurdos", () => {
    expect(a.filas.length).toBeGreaterThan(120);
    expect(a.filas.every((f) => f.minimo >= 0 && (f.maximo === null || f.maximo >= f.minimo))).toBe(true);
  });
});

describe("Anexo 8 RMF 2026 (fixture real)", () => {
  const a = parseAnexo8(fixture("anexo8-rmf-2026.txt"));
  it("cabecera", () => {
    expect(a.ejercicio).toBe(2026);
    expect(a.dof).toBe("2025-12-28");
  });
  it("clasifica títulos", () => {
    expect(clasificarTitulo("Tarifa aplicable cuando hagan pagos que correspondan a un periodo de 7 días, correspondiente a 2026").periodo).toBe("semanal");
    expect(clasificarTitulo("Tarifa del mes de marzo de 2026, para efectuar los pagos provisionales mensuales a que se refiere el artículo 106 de la Ley del ISR")).toMatchObject({ periodo: "acumulada", mes: 3, ejercicioTarifa: 2026 });
    expect(clasificarTitulo("Tarifa para el cálculo del impuesto correspondiente al ejercicio de 2025 a que se refieren los artículos 97 y 152 de la Ley del ISR")).toMatchObject({ periodo: "anual", ejercicioTarifa: 2025 });
  });
  it("tarifa mensual Art. 96: 11 filas, última «En adelante» 35 %", () => {
    const m = a.tarifas.find((t) => t.periodo === "mensual");
    expect(m?.filas).toHaveLength(11);
    expect(m?.filas[0]).toEqual({ limiteInferior: 0.01, limiteSuperior: 844.59, cuotaFija: 0, tasaExcedente: 0.0192 });
    expect(m?.filas[10]).toEqual({ limiteInferior: 425642, limiteSuperior: null, cuotaFija: 133488.54, tasaExcedente: 0.35 });
  });
  it("Art. 106: doce tarifas acumuladas, una por mes", () => {
    const acum = a.tarifas.filter((t) => t.periodo === "acumulada");
    expect(acum.map((t) => t.mes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(acum[11].filas[10].cuotaFija).toBe(1601862.46);
  });
  it("anual 2025 y 2026 (Art. 152)", () => {
    const anuales = a.tarifas.filter((t) => t.periodo === "anual");
    expect(anuales.map((t) => t.ejercicioTarifa)).toEqual([2025, 2026]);
    expect(anuales[1].filas[1]).toMatchObject({ limiteInferior: 10135.12, cuotaFija: 194.59, tasaExcedente: 0.064 });
  });
  it("retenciones por periodo: diaria, semanal, decenal, quincenal", () => {
    expect(a.tarifas.filter((t) => ["diaria", "semanal", "decenal", "quincenal"].includes(t.periodo)).map((t) => t.periodo)).toEqual(["diaria", "semanal", "decenal", "quincenal"]);
  });
  it("tarifasCoinciden detecta diferencias de una fila", () => {
    const m = a.tarifas.find((t) => t.periodo === "mensual")!.filas;
    expect(tarifasCoinciden(m, m).ok).toBe(true);
    const alterada = m.map((f, i) => (i === 3 ? { ...f, cuotaFija: f.cuotaFija + 1 } : f));
    expect(tarifasCoinciden(m, alterada).diferencias).toEqual(["fila 4 cuota fija 1011.68 vs 1012.68"]);
  });
});

describe("LIF 2026 (fragmento real)", () => {
  it("lee el artículo de recargos por contenido: 1.38 % prórroga y tres tramos de parcialidades", () => {
    const r = parseRecargosLif(fixture("lif-2026-fragmento.txt"));
    expect(r).toMatchObject({ ejercicio: 2026, articulo: "11", prorroga: 0.0138 });
    expect(r?.parcialidades).toEqual([
      { hastaMeses: 12, tasa: 0.0142 },
      { hastaMeses: 24, tasa: 0.0163 },
      { hastaMeses: null, tasa: 0.0197 },
    ]);
    expect(urlLif(2026)).toBe("https://www.diputados.gob.mx/LeyesBiblio/pdf/LIF_2026.pdf");
  });
  it("sin el artículo → null", () => {
    expect(parseRecargosLif("Artículo 1o. Nada que ver.")).toBeNull();
  });
});

describe("sat-anexos", () => {
  it("las URL candidatas empiezan por fin de diciembre del año anterior y contienen la real de 2026", () => {
    const u = urlsCandidatasAnexo(5, 2026);
    expect(u[0]).toMatch(/Anexo-5-RMF-2026_DOF-31122025\.pdf$/);
    expect(u).toContain("https://www.sat.gob.mx/minisitio/NormatividadRMFyRGCE/documentos2026/rmf/anexos/Anexo-5-RMF-2026_DOF-28122025.pdf");
  });
});
