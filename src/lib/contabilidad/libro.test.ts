import { describe, it, expect } from "vitest";
import { libroDiario, auxiliarCuenta, balanceGeneralDesdeBalanza, type EntryForLibro } from "./libro";
import { agruparPolizas, type EntryForPoliza } from "./coe-polizas";
import type { BalanzaRow } from "./posting";

const e = (over: Partial<EntryForLibro>): EntryForLibro => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  fecha: "2026-07-15",
  concepto: "Venta",
  tipo: "CARGO",
  monto: 100,
  referencia: null,
  referenciaTipo: null,
  fuente: "CFDI",
  numCta: "105.01",
  desCta: "Clientes nacionales",
  ...over,
});

describe("libroDiario", () => {
  const entries: EntryForLibro[] = [
    e({ id: "a1", referencia: "UUID-1", referenciaTipo: "CFDI", tipo: "CARGO", monto: 116, numCta: "105.01" }),
    e({ id: "a2", referencia: "UUID-1", referenciaTipo: "CFDI", tipo: "ABONO", monto: 100, numCta: "401.01" }),
    e({ id: "a3", referencia: "UUID-1", referenciaTipo: "CFDI", tipo: "ABONO", monto: 16, numCta: "209.01" }),
    e({ id: "b1", fecha: "2026-07-20", fuente: "MANUAL", referencia: "pol-m1", referenciaTipo: "POLIZA", tipo: "CARGO", monto: 50, numCta: "601.84" }),
    e({ id: "b2", fecha: "2026-07-20", fuente: "MANUAL", referencia: "pol-m1", referenciaTipo: "POLIZA", tipo: "ABONO", monto: 50, numCta: "102.01" }),
  ];

  it("agrupa por documento y cuadra cargos = abonos", () => {
    const libro = libroDiario(entries);
    expect(libro).toHaveLength(2);
    expect(libro[0].transacciones).toHaveLength(3);
    expect(libro[0].totalCargos).toBe(116);
    expect(libro[0].totalAbonos).toBe(116);
    expect(libro[0].cuadrada).toBe(true);
    expect(libro[1].fuente).toBe("MANUAL");
  });

  it("el folio en pantalla es IDÉNTICO al NumUnIdenPol del XML del SAT", () => {
    const libro = libroDiario(entries);
    const xml = agruparPolizas(entries as unknown as EntryForPoliza[]);
    expect(libro.map((p) => p.folio)).toEqual(xml.map((p) => p.numUnIdenPol));
    expect(libro.map((p) => p.fecha)).toEqual(xml.map((p) => p.fecha));
  });

  it("los totales del libro ≡ suma de los asientos", () => {
    const libro = libroDiario(entries);
    const cargos = entries.filter((x) => x.tipo === "CARGO").reduce((s, x) => s + x.monto, 0);
    expect(libro.reduce((s, p) => s + p.totalCargos, 0)).toBe(cargos);
  });
});

describe("auxiliarCuenta", () => {
  it("saldo corrido parte del saldo inicial y cierra en saldoFinal", () => {
    const movs = [
      e({ id: "m1", fecha: "2026-07-02", tipo: "CARGO", monto: 200 }),
      e({ id: "m2", fecha: "2026-07-10", tipo: "ABONO", monto: 80 }),
      e({ id: "m3", fecha: "2026-07-01", tipo: "CARGO", monto: 20 }),
    ];
    const aux = auxiliarCuenta(movs, 1000);
    expect(aux.movimientos.map((m) => m.fecha)).toEqual(["2026-07-01", "2026-07-02", "2026-07-10"]);
    expect(aux.movimientos[0].saldo).toBe(1020);
    expect(aux.movimientos[2].saldo).toBe(1140);
    expect(aux.saldoFinal).toBe(1140);
    expect(aux.totalCargos).toBe(220);
    expect(aux.totalAbonos).toBe(80);
  });
});

describe("balanceGeneralDesdeBalanza", () => {
  const row = (over: Partial<BalanzaRow>): BalanzaRow => ({
    cuentaSAT: "102",
    subcuenta: "102.01",
    nombre: "Bancos nacionales",
    tipo: "ACTIVO",
    nivel: 3,
    cargos: 0,
    abonos: 0,
    saldo: 0,
    saldoInicial: 0,
    saldoFinal: 0,
    ...over,
  });

  it("cuadra la ecuación contable con el resultado en curso como renglón virtual", () => {
    // Venta de 100+16 IVA cobrada: banco 116 / ingreso 100 / IVA 16.
    // Los tres en signo NATURAL, que es lo que produce saldosCoe: la acreedora
    // con saldo acreedor llega POSITIVA, no negativa.
    const rows: BalanzaRow[] = [
      row({ saldoFinal: 116 }),
      row({ cuentaSAT: "208", subcuenta: "208.01", nombre: "IVA trasladado cobrado", tipo: "PASIVO", saldoFinal: 16 }),
      row({ cuentaSAT: "401", subcuenta: "401.01", nombre: "Ventas", tipo: "INGRESO", saldoFinal: 100 }),
    ];
    const bg = balanceGeneralDesdeBalanza(rows);
    expect(bg.totalActivo).toBe(116);
    expect(bg.totalPasivo).toBe(16);
    expect(bg.totalCapital).toBe(0);
    expect(bg.resultadoEnCurso).toBe(100); // utilidad
    expect(bg.descuadre).toBe(0);
  });

  it("un pasivo con saldo normal NO se presenta en negativo", () => {
    // El defecto que enseñaba «Proveedores nacionales $-5,815,719,699.32».
    const bg = balanceGeneralDesdeBalanza([
      row({ cuentaSAT: "201", subcuenta: "201.01", nombre: "Proveedores nacionales", tipo: "PASIVO", saldoFinal: 5000 }),
    ]);
    expect(bg.pasivo[0].monto).toBe(5000);
    expect(bg.totalPasivo).toBe(5000);
  });

  it("el resultado en curso RESTA los gastos, no los suma", () => {
    // Sumarlos y cambiar el signo daba −(ingresos + gastos): a MARGOM le salía
    // −$10,910,475,873.36 de resultado del ejercicio.
    const bg = balanceGeneralDesdeBalanza([
      row({ cuentaSAT: "401", subcuenta: "401.01", nombre: "Ventas", tipo: "INGRESO", saldoFinal: 1000 }),
      row({ cuentaSAT: "601", subcuenta: "601.84", nombre: "Otros gastos", tipo: "GASTO", saldoFinal: 400 }),
      row({ cuentaSAT: "501", subcuenta: "501.01", nombre: "Costo de ventas", tipo: "COSTO", saldoFinal: 350 }),
    ]);
    expect(bg.resultadoEnCurso).toBe(250);
  });

  it("los niveles 1-2 y saldos ~0 no aparecen en el detalle", () => {
    const rows: BalanzaRow[] = [
      row({ nivel: 2, saldoFinal: 500 }),
      row({ saldoFinal: 0.004 }),
    ];
    const bg = balanceGeneralDesdeBalanza(rows);
    expect(bg.activo).toHaveLength(0);
  });
});
