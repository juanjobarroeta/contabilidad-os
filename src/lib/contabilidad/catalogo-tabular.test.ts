import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { detectarColumnas, filasDeArchivo, importeDeTexto, parseBalanzaTabular, parseCatalogoTabular } from "./catalogo-tabular";

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
