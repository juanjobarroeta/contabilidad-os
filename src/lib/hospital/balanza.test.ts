import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  analizarBalanza,
  detectarColumnas,
  interpretarBalanza,
  leerBalanza,
  numero,
  similitudNombre,
  sugerirCuenta,
  type CuentaCatalogo,
} from "./balanza";
import { HospitalError } from "./errores";

const CATALOGO: CuentaCatalogo[] = [
  { codigo: "101", nombre: "Caja", tipo: "ACTIVO", naturaleza: "D", nivel: 2 },
  { codigo: "101.01", nombre: "Caja y efectivo", tipo: "ACTIVO", naturaleza: "D", nivel: 3 },
  { codigo: "102.01", nombre: "Bancos nacionales", tipo: "ACTIVO", naturaleza: "D", nivel: 3 },
  { codigo: "105.01", nombre: "Clientes nacionales", tipo: "ACTIVO", naturaleza: "D", nivel: 3 },
  { codigo: "115.01", nombre: "Inventario", tipo: "ACTIVO", naturaleza: "D", nivel: 3 },
  { codigo: "201.01", nombre: "Proveedores nacionales", tipo: "PASIVO", naturaleza: "A", nivel: 3 },
  { codigo: "206.01", nombre: "Anticipo de cliente nacional", tipo: "PASIVO", naturaleza: "A", nivel: 3 },
  { codigo: "301.01", nombre: "Capital fijo", tipo: "CAPITAL", naturaleza: "A", nivel: 3 },
  { codigo: "304.01", nombre: "Utilidad de ejercicios anteriores", tipo: "CAPITAL", naturaleza: "A", nivel: 3 },
];

function xlsx(filas: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), "Balanza");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("numero()", () => {
  it("lee lo que exportan los sistemas contables", () => {
    expect(numero(1234.5)).toBe(1234.5);
    expect(numero("$1,234.50")).toBe(1234.5);
    expect(numero("(500.00)")).toBe(-500);
    expect(numero("-500")).toBe(-500);
    expect(numero("1.234,56")).toBe(1234.56);
    expect(numero(" 12 345.10 ")).toBe(12345.1);
    expect(numero("")).toBeNull();
    expect(numero("-")).toBeNull();
    expect(numero("Bancos")).toBeNull();
    expect(numero(null)).toBeNull();
  });
});

describe("detectarColumnas()", () => {
  it("encabezado con saldo deudor/acreedor (título arriba)", () => {
    const filas = [
      ["HOSPITAL SAN JOSÉ SA DE CV"],
      ["Balanza de comprobación al 31 de agosto de 2026"],
      [],
      ["Cuenta", "Nombre de la cuenta", "Saldo inicial deudor", "Saldo inicial acreedor", "Cargos", "Abonos", "Saldo final deudor", "Saldo final acreedor"],
      ["101.01", "Caja", 0, 0, 100, 0, 100, 0],
    ];
    expect(detectarColumnas(filas)).toEqual({ encabezado: 3, codigo: 0, nombre: 1, deudor: 6, acreedor: 7, saldo: null });
  });

  it("encabezado con un solo saldo (con signo)", () => {
    expect(detectarColumnas([["Código", "Descripción", "Saldo final"], ["101.01", "Caja", 100]])).toEqual({ encabezado: 0, codigo: 0, nombre: 1, deudor: null, acreedor: null, saldo: 2 });
  });

  it("sin encabezado: por posición", () => {
    expect(detectarColumnas([["101.01", "Caja", 100, 0], ["201.01", "Proveedores", 0, 100]])).toEqual({ encabezado: null, codigo: 0, nombre: 1, deudor: 2, acreedor: 3, saldo: null });
    expect(detectarColumnas([["101.01", "Caja", 100]])).toEqual({ encabezado: null, codigo: 0, nombre: 1, deudor: null, acreedor: null, saldo: 2 });
  });

  it("nada reconocible → null y 400 al interpretar", () => {
    expect(detectarColumnas([["hola", "mundo"], ["a", "b"]])).toBeNull();
    expect(() => interpretarBalanza([["hola", "mundo"]])).toThrow(HospitalError);
  });
});

describe("similitudNombre() / sugerirCuenta()", () => {
  it("parecido por palabras significativas", () => {
    expect(similitudNombre("BANCOS", "Bancos nacionales")).toBe(0.5);
    expect(similitudNombre("Clientes", "Clientes nacionales")).toBe(0.5);
    expect(similitudNombre("IVA acreditable", "IVA acreditable pagado")).toBeCloseTo(2 / 3);
    expect(similitudNombre("Caja chica", "Bancos nacionales")).toBe(0);
  });

  it("exacta → prefijo del agrupador → nombre → null", () => {
    expect(sugerirCuenta({ codigo: "102.01", nombre: "x" }, CATALOGO)).toMatchObject({ confianza: "EXACTA", cuenta: { codigo: "102.01" } });
    expect(sugerirCuenta({ codigo: "102-01", nombre: "x" }, CATALOGO)).toMatchObject({ confianza: "EXACTA", cuenta: { codigo: "102.01" } });
    // 101.01.003 no existe: el agrupador 101.01 sí.
    expect(sugerirCuenta({ codigo: "101.01.003", nombre: "Caja chica" }, CATALOGO)).toMatchObject({ confianza: "PREFIJO", cuenta: { codigo: "101.01" } });
    expect(sugerirCuenta({ codigo: "101-5", nombre: "Fondo fijo" }, CATALOGO)).toMatchObject({ confianza: "PREFIJO", cuenta: { codigo: "101" } });
    // Plan propio de 4 dígitos: no hay agrupador que leer; el nombre decide.
    expect(sugerirCuenta({ codigo: "1050-0001-0000", nombre: "CLIENTES" }, CATALOGO)).toMatchObject({ confianza: "NOMBRE", cuenta: { codigo: "105.01" } });
    expect(sugerirCuenta({ codigo: "9999-0001-0000", nombre: "CUENTA PUENTE" }, CATALOGO)).toBeNull();
  });
});

describe("leerBalanza() con un xlsx armado en el test", () => {
  const hoja = [
    ["HOSPITAL SAN JOSÉ SA DE CV"],
    ["Balanza de comprobación al 31 de agosto de 2026"],
    ["Cuenta", "Nombre", "Saldo deudor", "Saldo acreedor"],
    ["100", "ACTIVO", "1,250,000.00", ""],
    ["101", "Caja", "50,000.00", ""],
    ["101.01", "Caja y efectivo", "50,000.00", ""],
    ["102.01", "Bancos", "1,000,000.00", ""],
    ["105.01", "Clientes nacionales", "200,000.00", ""],
    ["200", "PASIVO", "", "450,000.00"],
    ["201.01", "Proveedores nacionales", "", "400,000.00"],
    ["206.01", "Anticipos de pacientes", "", "50,000.00"],
    ["301.01", "Capital social", "", "700,000.00"],
    ["304.01", "Resultados acumulados", "", "100,000.00"],
    ["Total", "", "1,250,000.00", "1,250,000.00"],
  ];

  it("líneas, agrupadoras fuera del total, sugerencias y cuadre", () => {
    const r = leerBalanza(xlsx(hoja), "balanza.xlsx", CATALOGO);
    expect(r.columnas).toMatchObject({ encabezado: 2, codigo: 0, nombre: 1, deudor: 2, acreedor: 3 });
    expect(r.lineas.map((l) => l.codigo)).toEqual(["100", "101", "101.01", "102.01", "105.01", "200", "201.01", "206.01", "301.01", "304.01"]);
    expect(r.lineas.filter((l) => l.agrupadora).map((l) => l.codigo)).toEqual(["101"]);
    const por = Object.fromEntries(r.lineas.map((l) => [l.codigo, l]));
    expect(por["102.01"]).toMatchObject({ saldoDeudor: 1_000_000, saldoAcreedor: 0, saldo: 1_000_000, confianza: "EXACTA", cuentaSugerida: { codigo: "102.01" } });
    // Acreedora: el saldo natural es +abono.
    expect(por["201.01"]).toMatchObject({ saldo: 400_000, confianza: "EXACTA" });
    expect(por["100"]).toMatchObject({ agrupadora: false, cuentaSugerida: null });
    // Un «100» sin hijas con separador no se detecta como agrupadora: queda sin mapear y desbalancea.
    expect(r.sinMapear.map((l) => l.codigo)).toEqual(["100", "200"]);
    expect(r.totales).toMatchObject({ cuentas: 9, deudor: 2_500_000, acreedor: 1_700_000, cuadra: false });
    expect(r.advertencia).toContain("no cuadra");
  });

  it("sin los totales de nivel 1, cuadra al centavo y no hay advertencia", () => {
    const limpia = hoja.filter((f) => !["100", "200"].includes(String(f[0])));
    const r = leerBalanza(xlsx(limpia), "balanza.xlsx", CATALOGO);
    expect(r.totales).toMatchObject({ cuentas: 7, deudor: 1_250_000, acreedor: 1_250_000, diferencia: 0, cuadra: true });
    expect(r.sinMapear).toEqual([]);
    expect(r.advertencia).toBeNull();
    // Lo que va a POST /apertura: código sugerido y saldo natural.
    const lineas = r.lineas.filter((l) => !l.agrupadora).map((l) => ({ codigo: l.cuentaSugerida!.codigo, saldo: l.saldo }));
    expect(lineas).toEqual([
      { codigo: "101.01", saldo: 50_000 },
      { codigo: "102.01", saldo: 1_000_000 },
      { codigo: "105.01", saldo: 200_000 },
      { codigo: "201.01", saldo: 400_000 },
      { codigo: "206.01", saldo: 50_000 },
      { codigo: "301.01", saldo: 700_000 },
      { codigo: "304.01", saldo: 100_000 },
    ]);
  });

  it("csv con saldo final con signo (negativo = acreedor) y BOM", () => {
    const csv =
      "\uFEFFCódigo,Descripción,Saldo final\n" +
      "101.01,Caja,\"$50,000.00\"\n" +
      "102.01,Bancos,\"$100,000.00\"\n" +
      "201.01,Proveedores,\"($150,000.00)\"\n";
    const r = leerBalanza(Buffer.from(csv, "utf8"), "balanza.csv", CATALOGO);
    expect(r.columnas).toMatchObject({ codigo: 0, nombre: 1, saldo: 2 });
    expect(r.lineas.map((l) => [l.codigo, l.saldoDeudor, l.saldoAcreedor, l.saldo])).toEqual([
      ["101.01", 50_000, 0, 50_000],
      ["102.01", 100_000, 0, 100_000],
      ["201.01", 0, 150_000, 150_000],
    ]);
    expect(r.totales.cuadra).toBe(true);
  });

  it("archivo que no es hoja → 400", () => {
    expect(() => leerBalanza(Buffer.from("%PDF-1.4 nada"), "x.pdf", CATALOGO)).toThrow(HospitalError);
  });

  it("descuadre real rebasa la tolerancia de redondeo", () => {
    const r = analizarBalanza([["Cuenta", "Nombre", "Deudor", "Acreedor"], ["101.01", "Caja", 100.01, 0], ["201.01", "Proveedores", 0, 100]], CATALOGO);
    expect(r.totales).toMatchObject({ diferencia: 0.01, tolerancia: 0.01, cuadra: true });
    const r2 = analizarBalanza([["Cuenta", "Nombre", "Deudor", "Acreedor"], ["101.01", "Caja", 100.03, 0], ["201.01", "Proveedores", 0, 100]], CATALOGO);
    expect(r2.totales.cuadra).toBe(false);
  });
});
