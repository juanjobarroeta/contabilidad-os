import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { categoriaDeGrupo, filasDeArchivo, leerListaPrecios, planearImportacion, resumirPlan } from "./tarifario-importar";

const hoja = (filas: unknown[][]) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), "Hoja1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};
const ENC = ["Clave", "Descripcion", "Grupo", "lista de precio", "Precio", "Costo"];

describe("leerListaPrecios", () => {
  it("reads the hospital's export as is", () => {
    const r = leerListaPrecios(filasDeArchivo(hoja([
      ENC,
      ["PAQ001", "ENDOSCOPIA DIAGNOSTICA", "PAQ", "PARTICULAR", 1457.5, null],
      ["ENDOS011", "SALA CIRUGIA 60 MINUTOS", "ENDOS ", "PARTICULAR", 2475, null],
      [" lc001 ", "  ANTÍGENO   COVID ", "LC", "PARTICULAR", "$332.84", null],
    ])));
    expect(r.errores).toEqual([]);
    expect(r.listas).toEqual(["PARTICULAR"]);
    expect(r.filas.map((f) => [f.clave, f.descripcion, f.grupo, f.precio])).toEqual([
      ["PAQ001", "ENDOSCOPIA DIAGNOSTICA", "PAQ", 1457.5],
      ["ENDOS011", "SALA CIRUGIA 60 MINUTOS", "ENDOS", 2475],
      ["LC001", "ANTÍGENO COVID", "LC", 332.84],
    ]);
  });
  it("reports bad rows instead of guessing", () => {
    const r = leerListaPrecios([ENC, ["", "SIN CLAVE", "LC", "P", 10], ["X1", "", "LC", "P", 10], ["X2", "SIN PRECIO", "LC", "P", "abc"], ["X3", "OK", "LC", "P", 5], ["X3", "DUP", "LC", "P", 6]]);
    expect(r.filas.map((f) => f.clave)).toEqual(["X3"]);
    expect(r.errores.map((e) => e.motivo)).toEqual(["sin clave", "X1: sin descripción", "X2: precio inválido", "X3: repetida (ya viene en la fila 5)"]);
  });
  it("needs a header with clave, descripción and precio", () => {
    expect(() => leerListaPrecios([["a", "b"], [1, 2]])).toThrow(/encabezado/);
  });
});

describe("categoriaDeGrupo", () => {
  it("maps the hospital groups to charge categories", () => {
    expect(categoriaDeGrupo("LC")).toBe("ESTUDIO");
    expect(categoriaDeGrupo("TAC")).toBe("ESTUDIO");
    expect(categoriaDeGrupo("ENDOS ")).toBe("QUIROFANO");
    expect(categoriaDeGrupo("HON")).toBe("HONORARIO");
    expect(categoriaDeGrupo("UCI16")).toBe("PROCEDIMIENTO");
    expect(categoriaDeGrupo("URG")).toBe("URGENCIAS");
    expect(categoriaDeGrupo(null)).toBe("OTRO");
  });
});

describe("planearImportacion", () => {
  const filas = leerListaPrecios([ENC, ["A1", "UNO", "LC", "P", 100], ["B2", "DOS", "LC", "P", 200], ["C3", "TRES", "LC", "P", 300]]).filas;
  const existentes = [
    { id: "a", clave: "A1", nombre: "UNO", grupo: "LC", precioLista: 100, activo: true },
    { id: "b", clave: "B2", nombre: "DOS", grupo: "LC", precioLista: 180, activo: true },
    { id: "z", clave: "Z9", nombre: "VIEJO", grupo: "LC", precioLista: 50, activo: true },
  ];
  it("re-importing only touches what changed", () => {
    const plan = planearImportacion(filas, existentes, "LISTA");
    expect(plan.nuevos.map((f) => f.clave)).toEqual(["C3"]);
    expect(plan.cambios.map((c) => [c.clave, c.antes, c.precio])).toEqual([["B2", 180, 200]]);
    expect(plan.iguales).toBe(1);
    expect(plan.faltantes.map((f) => f.clave)).toEqual(["Z9"]);
    expect(resumirPlan(plan).subidas).toBe(1);
  });
  it("a payer list compares against that payer's price, not the list price", () => {
    const plan = planearImportacion(filas, existentes.map((s) => ({ ...s, precioPagador: s.clave === "A1" ? 90 : null })), { pagadorId: "gnp" });
    expect(plan.cambios.map((c) => [c.clave, c.antes, c.precio])).toEqual([["A1", 90, 100], ["B2", null, 200]]);
    expect(plan.faltantes).toEqual([]);
  });
  it("a service that was deactivated comes back", () => {
    const plan = planearImportacion(filas.slice(0, 1), [{ ...existentes[0], activo: false }], "LISTA");
    expect(plan.cambios[0]).toMatchObject({ clave: "A1", reactivar: true });
  });
});
