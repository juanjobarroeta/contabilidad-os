import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { categoriaDeGrupo, destinoDeMapeo, filasDeArchivo, leerListaPrecios, planearImportacion, resumirPlan, sugerirMapeo } from "./tarifario-importar";

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

describe("leerListaPrecios — formato ANCHO (una columna de precio por lista)", () => {
  const ANCHO = ["Clave", "Descripcion", "BUPA", "MEDIPROSES", "ONCOCENTER", "PARTEXT", "PARTICULAR", "PLANSEG", "PREVEM", "PXEXTERNO", "SOFIA", "SURA", "VITA"];
  it("lee cada celda con precio como una lista; la celda vacía es «no la cobra»", () => {
    const r = leerListaPrecios(filasDeArchivo(hoja([
      ANCHO,
      ["AMB001", "AMBULANCIA DE URGENCIA", null, null, null, null, "$3,080.00", null, null, null, null, null, null],
      ["AMB003", "\tTERAPIA INTERMEDIA (OXIGENO BAJO FLUJO)", null, null, null, null, "$3,850.00", null, null, null, null, null, null],
      ["BM002", "PANEL PEDIÁTRICO", "$2,211.90", "$2,764.88", null, null, "$2,140.22", "$2,764.88", "$2,764.88", "$2,140.22", "$2,930.77", "$2,930.77", "$2,764.88"],
      ["URG021", "CURACIONES", 264.42, " $330.52 ", null, null, 255.85, null, null, null, 350.35, 350.35, null],
    ])));
    expect(r.formato).toBe("ANCHO");
    expect(r.errores).toEqual([]);
    expect(r.columnasPrecio.find((c) => c.encabezado === "PARTICULAR")).toEqual({ encabezado: "PARTICULAR", filasConPrecio: 4 });
    expect(r.columnasPrecio.find((c) => c.encabezado === "BUPA")?.filasConPrecio).toBe(2);
    const amb3 = r.filas.find((f) => f.clave === "AMB003")!;
    expect([amb3.descripcion, amb3.grupo, amb3.lista, amb3.precio]).toEqual(["TERAPIA INTERMEDIA (OXIGENO BAJO FLUJO)", "AMB", "PARTICULAR", 3850]);
    expect(r.filas.filter((f) => f.clave === "BM002")).toHaveLength(9); // ONCOCENTER y PARTEXT vienen vacías
    expect(r.filas.find((f) => f.clave === "URG021" && f.lista === "MEDIPROSES")?.precio).toBe(330.52);
  });
  it("reporta precio inválido y filas sin ningún precio, sin adivinar", () => {
    const r = leerListaPrecios([["Clave", "Descripcion", "BUPA", "SURA", "NOTAS"], ["X1", "UNO", "abc", 10, "ok"], ["X2", "DOS", null, null, null], ["X3", "TRES", 5, 6, "revisar"], ["X4", "CUATRO", 7, 8, null], ["X5", "CINCO", 9, 9, null], ["X6", "SEIS", 1, 1, null]]);
    expect(r.formato).toBe("ANCHO");
    // «NOTAS» no es columna de precio (casi todo es texto); un «abc» en una columna de precios sí es error.
    expect(r.columnasPrecio.map((c) => c.encabezado)).toEqual(["BUPA", "SURA"]);
    expect(r.errores.map((e) => e.motivo)).toEqual(["X1: precio inválido en BUPA", "X2: sin precio en ninguna lista"]);
    expect(r.filas.filter((f) => f.clave === "X1").map((f) => f.lista)).toEqual(["SURA"]);
  });
  it("el formato largo no cambia", () => {
    const r = leerListaPrecios([ENC, ["PAQ001", "ENDOSCOPIA", "PAQ", "PARTICULAR", 10, null]]);
    expect([r.formato, r.columnasPrecio]).toEqual(["LARGO", []]);
  });
});

describe("sugerirMapeo", () => {
  const pag = [
    { id: "p-part", nombre: "Particular", tabulador: null },
    { id: "p-prevem", nombre: "Prevem Seguros", tabulador: null },
    { id: "p-sura", nombre: "Seguros Sura", tabulador: null },
    { id: "p-plan", nombre: "Plan Seguro SA de CV Compañia de Seguros", tabulador: null },
    { id: "p-onco", nombre: "Onco Hope", tabulador: null },
    { id: "p-axa", nombre: "Axa Seguros", tabulador: null },
  ];
  const ENCS = ["BUPA", "MEDIPROSES", "ONCOCENTER", "PARTEXT", "PARTICULAR", "PLANSEG", "PREVEM", "PXEXTERNO", "SOFIA", "SURA", "VITA"];
  it("CENTRO: lista, pagadores que coinciden y los nuevos con lo que dijo el dueño", () => {
    const s = sugerirMapeo(ENCS, pag);
    expect(s.mapeo).toEqual({
      BUPA: "NUEVO:ASEGURADORA:BUPA",
      MEDIPROSES: "NUEVO:EMPRESA:MEDIPROSES",
      ONCOCENTER: "p-onco",
      PARTEXT: "NUEVO:PARTICULAR:Particular externo",
      PARTICULAR: "LISTA",
      PLANSEG: "p-plan",
      PREVEM: "p-prevem",
      PXEXTERNO: "NUEVO:PARTICULAR:Paciente externo",
      SOFIA: "NUEVO:EMPRESA:Sofía",
      SURA: "p-sura",
      VITA: "NUEVO:EMPRESA:VITA",
    });
    expect(s.porConfirmar).toEqual(["BUPA", "MEDIPROSES", "VITA"]);
  });
  it("la siguiente vez se mapea sola: alias de la empresa y tabulador ganan", () => {
    const s = sugerirMapeo(["SOFIA", "BUPA", "RARA"], [...pag, { id: "p-sofia", nombre: "Sofía", tabulador: "SOFIA" }, { id: "p-bupa", nombre: "Bupa México", tabulador: null }], { bupa: { pagadorId: "p-bupa" } });
    expect(s.mapeo).toEqual({ SOFIA: "p-sofia", BUPA: "p-bupa", RARA: "NUEVO:EMPRESA:RARA" });
    expect(s.porConfirmar).toEqual(["RARA"]);
  });
  it("si dos pagadores empatan no adivina", () => {
    const s = sugerirMapeo(["GNP"], [{ id: "a", nombre: "GNP", tabulador: null }, { id: "b", nombre: "GNP Seguros", tabulador: null }]);
    expect(s.mapeo.GNP).toBe("NUEVO:EMPRESA:GNP");
  });
});

describe("destinoDeMapeo", () => {
  it("lee LISTA, pagador, NUEVO con y sin tipo, y OMITIR", () => {
    expect(destinoDeMapeo("LISTA")).toEqual({ tipo: "LISTA" });
    expect(destinoDeMapeo("p1")).toEqual({ tipo: "PAGADOR", pagadorId: "p1" });
    expect(destinoDeMapeo("NUEVO:PARTICULAR:Paciente externo")).toEqual({ tipo: "NUEVO", nombre: "Paciente externo", pagadorTipo: "PARTICULAR" });
    expect(destinoDeMapeo("NUEVO:Sofía")).toEqual({ tipo: "NUEVO", nombre: "Sofía", pagadorTipo: "ASEGURADORA" });
    expect(destinoDeMapeo("")).toEqual({ tipo: "OMITIR" });
    expect(destinoDeMapeo("OMITIR")).toEqual({ tipo: "OMITIR" });
  });
});
