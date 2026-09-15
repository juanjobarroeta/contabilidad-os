import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { detectarColumnas, filasDeArchivo, importeDeTexto, parseBalanzaTabular, parseCatalogoTabular, agrupadorDeCelda } from "./catalogo-tabular";

const CONTPAQI = `Código,Nombre,Tipo,Naturaleza,Nivel,Código agrupador SAT
101000000,Caja,Activo,Deudora,1,101
101001000,Caja general,Activo,Deudora,2,101.01
201000000,Proveedores,Pasivo,Acreedora,1,201
201001000,Proveedores nacionales,Pasivo,Acreedora,2,201.01
,fila sin código,,,,
`;

const ASPEL = `﻿Cuenta;Descripción;Naturaleza;Nivel;Agrupador;Subcuenta de
1000;ACTIVO;D;1;100;
1100;CAJA;D;2;101;1000
1101;CAJA GENERAL;D;3;101.01;1100
2000;PASIVO;A;1;200;
`;

describe("filasDeArchivo — CSV con coma, con «;» y BOM, y Excel", () => {
  it("lee las tres formas como filas de texto", () => {
    expect(filasDeArchivo(CONTPAQI)[1]).toEqual(["101000000", "Caja", "Activo", "Deudora", "1", "101"]);
    expect(filasDeArchivo(ASPEL)[0][0]).toBe("Cuenta");
    expect(filasDeArchivo(ASPEL)[2]).toEqual(["1100", "CAJA", "D", "2", "101", "1000"]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Código", "Nombre"], [601.01, "Sueldos"]]), "Catálogo");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
    expect(filasDeArchivo(bytes)).toEqual([["Código", "Nombre"], ["601.01", "Sueldos"]]);
  });
});

describe("parseCatalogoTabular", () => {
  it("CONTPAQi: naturaleza en palabras, nivel y agrupador en columnas; la fila sin código se avisa", () => {
    const r = parseCatalogoTabular(CONTPAQI);
    expect(r.cuentas).toHaveLength(4);
    expect(r.cuentas[1]).toEqual({ codAgrup: "101.01", numCta: "101001000", desc: "Caja general", nivel: 2, natur: "D", subCtaDe: null });
    expect(r.cuentas[3].natur).toBe("A");
    expect(r.columnas.agrupador).toBe("Código agrupador SAT");
    expect(r.advertencias).toEqual(["1 fila(s) sin código se omitieron."]);
  });

  it("Aspel COI: «;», BOM, D/A y la columna «Subcuenta de» se conserva como padre", () => {
    const r = parseCatalogoTabular(ASPEL);
    expect(r.cuentas.map((c) => [c.numCta, c.subCtaDe, c.nivel])).toEqual([["1000", null, 1], ["1100", "1000", 2], ["1101", "1100", 3], ["2000", null, 1]]);
    expect(r.advertencias).toEqual([]);
  });

  it("sin nivel ni naturaleza: el nivel sale de los padres (o del código) y la naturaleza del agrupador", () => {
    const csv = `Cuenta,Nombre,Agrupador,Padre
100,Activo,100,
100.01,Caja,101.01,100
100.01.001,Caja chica,101.01,100.01
600.01,Sueldos,601.01,
`;
    const r = parseCatalogoTabular(csv);
    // Con columna de padre, una fila sin padre es raíz (nivel 1) aunque su código lleve punto.
    expect(r.cuentas.map((c) => [c.numCta, c.nivel, c.natur])).toEqual([["100", 1, "D"], ["100.01", 2, "D"], ["100.01.001", 3, "D"], ["600.01", 1, "D"]]);
    // Sin columna de padre, el nivel sale de los segmentos del código.
    const sinPadre = parseCatalogoTabular("Cuenta,Nombre,Agrupador\n600.01,Sueldos,601.01\n600.01.001,Base,601.01\n");
    expect(sinPadre.cuentas.map((c) => c.nivel)).toEqual([2, 3]);
  });

  it("sin naturaleza, sin agrupador y sin tipo, la cuenta se omite y se avisa; con «tipo» se deduce", () => {
    const csv = `Código,Nombre,Tipo
101,Caja,Activo
201,Proveedores,Pasivo
999,Misterio,
`;
    const r = parseCatalogoTabular(csv);
    expect(r.cuentas.map((c) => [c.numCta, c.natur])).toEqual([["101", "D"], ["201", "A"]]);
    expect(r.advertencias.some((a) => a.includes("1 cuenta(s) sin naturaleza"))).toBe(true);
    expect(r.advertencias.some((a) => a.includes("Sin columna de código agrupador"))).toBe(true);
  });

  it("sin encabezados reconocibles no inventa nada", () => {
    const r = parseCatalogoTabular("a,b,c\n1,2,3\n");
    expect(r.cuentas).toEqual([]);
    expect(r.advertencias[0]).toContain("encabezados");
  });

  it("detectarColumnas salta las filas de título antes del encabezado", () => {
    const filas = [["Empresa X, S.A. de C.V."], ["Catálogo de cuentas al 31/08/2026"], [], ["Código", "Nombre", "Naturaleza"], ["101", "Caja", "D"]];
    const det = detectarColumnas(filas, { codigo: /^c[oó]digo$/i, nombre: /^nombre$/i, naturaleza: /^naturaleza$/i } as never);
    expect(det?.fila).toBe(3);
  });
});

describe("importeDeTexto", () => {
  it("pesos con símbolo y comas, paréntesis negativos, europeo", () => {
    expect(importeDeTexto("$1,234.56")).toBe(1234.56);
    expect(importeDeTexto("(500.00)")).toBe(-500);
    expect(importeDeTexto("-1,000")).toBe(-1000);
    expect(importeDeTexto("1.234,56")).toBe(1234.56);
    expect(importeDeTexto("")).toBe(0);
  });
});

describe("parseBalanzaTabular", () => {
  it("cuenta, saldo inicial, cargos, abonos, saldo final; la fila de totales se salta; sin final se deriva", () => {
    const csv = `Cuenta,Nombre,Saldo inicial,Cargos,Abonos,Saldo final
102.01,Bancos,"$50,000.00","$10,000.00","$2,000.00","$58,000.00"
201.01,Proveedores,"20,000.00",0,"8,000.00","28,000.00"
Total,,70000,10000,10000,86000
`;
    const r = parseBalanzaTabular(csv);
    expect(r.cuentas).toEqual([
      { numCta: "102.01", saldoIni: 50000, debe: 10000, haber: 2000, saldoFin: 58000 },
      { numCta: "201.01", saldoIni: 20000, debe: 0, haber: 8000, saldoFin: 28000 },
    ]);
    const sinFinal = parseBalanzaTabular("Cuenta,Saldo inicial,Debe,Haber\n102.01,100,50,20\n");
    expect(sinFinal.cuentas[0].saldoFin).toBe(130);
  });
});

// El archivo que manda un hospital trae el agrupador con letras: «Agrupador
// del SAT: Inventario». Copiarlo tal cual dejaba codAgrup = "Inventario", que
// no es del Anexo 24: el SAT rechaza el catálogo y el motor no puede invertir
// ni una cuenta, con el dato completo en el archivo y sólo mal escrito.
describe("agrupadorDeCelda()", () => {
  it("un código del Anexo 24 se respeta tal cual", () => {
    expect(agrupadorDeCelda("115.01")).toBe("115.01");
    expect(agrupadorDeCelda(" 115.01 ")).toBe("115.01");
  });

  // Un mismo nombre vive en dos niveles («Inventario» es 115 y 115.01): gana el
  // más específico, que es lo que le toca a una cuenta de detalle y lo que el
  // SAT ya aceptó en los catálogos presentados.
  it("un nombre oficial se traduce a su código, con acentos o sin ellos", () => {
    expect(agrupadorDeCelda("Inventario")).toBe("115.01");
    expect(agrupadorDeCelda("Maquinaria y equipo")).toBe("153.01");
    // Sin acentos y en mayúsculas, como lo exporta más de un sistema.
    expect(agrupadorDeCelda("ESTIMACION DE CUENTAS INCOBRABLES")).toBe("108");
    expect(agrupadorDeCelda("Estimación de cuentas incobrables")).toBe("108");
    expect(agrupadorDeCelda("Ventas y/o servicios gravados al 0%")).toBe("401.04");
  });

  it("nombre repetido: gana el padre, que es el que va antes en el catálogo", () => {
    expect(agrupadorDeCelda("Ingresos")).toBe("400");
  });

  it("lo que no está en la lista se deja como vino: inventar un código es peor", () => {
    expect(agrupadorDeCelda("Almacen de mi tío")).toBe("Almacendemitío");
    expect(agrupadorDeCelda("")).toBe("");
  });
});

// El dialecto de un sistema hospitalario, tal como llegó: preámbulo de reporte
// con un bloque de filtros que repite los encabezados, códigos con separador de
// millares, «Nombre de cuenta», la naturaleza escondida en la columna Tipo y el
// agrupador con letras. Ninguna de las cinco cosas es exótica; juntas dejaban el
// catálogo en cero.
const HOSPITAL = [
  ["Hoja:     1", "", "", "", "", ""],
  ["Listado de Cuentas", "", "", "", "", "Fecha 11/09/2026"],
  ["Columna", "Filtro", "", "", "", ""],
  ["Cuenta", "Todos", "", "", "", ""],
  ["Agrupador del SAT", "Todos", "", "", "", ""],
  ["", "", "", "", "", ""],
  ["Cuenta", "Nombre de cuenta", "Tipo", "Cuenta de mayor", "Moneda", "Agrupador del SAT"],
  ["100,000,000", "Activo", "Activo Deudora", "No", "Peso Mexicano", ""],
  ["400,000,000", "Ingresos", "Resultados Acreedora", "No", "Peso Mexicano", ""],
  ["115,001,006", "Almacen Farmacia\n\nIntrahospitalaria", "Activo Deudora", "No", "Peso Mexicano", "Inventario"],
  ["153,001,064", "Ecografo gabinete r700", "Activo Deudora", "No", "Peso Mexicano", "Maquinaria y equipo"],
];

describe("parseCatalogoTabular() — el listado de un hospital", () => {
  const hoja = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(hoja, XLSX.utils.aoa_to_sheet(HOSPITAL), "Hoja1");
  const buf = XLSX.write(hoja, { type: "array", bookType: "xlsx" }) as Uint8Array;
  const r = parseCatalogoTabular(buf);

  it("encuentra los encabezados de verdad, no los del bloque de filtros", () => {
    expect(r.columnas.codigo).toBe("Cuenta");
    expect(r.columnas.nombre).toBe("Nombre de cuenta");
    expect(r.columnas.agrupador).toBe("Agrupador del SAT");
  });

  it("lee las cuatro cuentas: ninguna se cae por naturaleza ni por el código con comas", () => {
    expect(r.cuentas.map((c) => c.numCta)).toEqual(["100000000", "400000000", "115001006", "153001064"]);
    // «Resultados Acreedora» no empieza por PASIVO/CAPITAL/INGRESO, pero lo dice.
    expect(r.cuentas.find((c) => c.numCta === "400000000")?.natur).toBe("A");
  });

  it("traduce el agrupador escrito con letras y deja el nombre en un renglón", () => {
    const farmacia = r.cuentas.find((c) => c.numCta === "115001006")!;
    expect(farmacia.codAgrup).toBe("115.01");
    expect(farmacia.desc).toBe("Almacen Farmacia Intrahospitalaria");
    expect(r.cuentas.find((c) => c.numCta === "153001064")?.codAgrup).toBe("153.01");
  });

  it("los títulos sin agrupador quedan sin código, y el aviso lo dice", () => {
    expect(r.cuentas.find((c) => c.numCta === "100000000")?.codAgrup).toBe("");
    expect(r.advertencias.join(" ")).toContain("se tradujeron");
  });

  it("el nivel sale del código de nueve dígitos, sin columna de nivel", () => {
    expect(r.cuentas.find((c) => c.numCta === "100000000")?.nivel).toBe(1);
    expect(r.cuentas.find((c) => c.numCta === "115001006")?.nivel).toBe(3);
  });
});
