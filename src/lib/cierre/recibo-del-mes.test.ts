import { describe, it, expect } from "vitest";
import { reciboCubreElMes, empleadosConFiniquitoCerrado } from "./evaluar";

const agosto = { from: new Date(2026, 7, 1), to: new Date(2026, 8, 1) };
const run = (periodo: string, fechaPago: string) => ({ periodo, fechaPago: new Date(`${fechaPago}T12:00:00Z`) });

describe("reciboCubreElMes()", () => {
  it("la quincena trabajada en agosto cuenta en agosto aunque se pague en septiembre", () => {
    expect(reciboCubreElMes(run("2026-08-16/2026-08-31", "2026-09-01"), agosto.from, agosto.to)).toBe(true);
  });

  it("pagada dentro del mes, cuenta sin mirar el periodo", () => {
    expect(reciboCubreElMes(run("basura", "2026-08-15"), agosto.from, agosto.to)).toBe(true);
  });

  it("la quincena de julio pagada en agosto no convierte a julio en agosto", () => {
    // Se pagó el 1 de agosto: cuenta en agosto por fecha de pago…
    expect(reciboCubreElMes(run("2026-07-16/2026-07-31", "2026-08-01"), agosto.from, agosto.to)).toBe(true);
    // …pero una pagada en julio, con periodo de julio, no toca agosto.
    expect(reciboCubreElMes(run("2026-07-01/2026-07-15", "2026-07-15"), agosto.from, agosto.to)).toBe(false);
  });

  it("un periodo con formato raro no descarta: manda la fecha de pago", () => {
    expect(reciboCubreElMes(run("", "2026-09-10"), agosto.from, agosto.to)).toBe(false);
    expect(reciboCubreElMes(run("2026-08-01", "2026-09-10"), agosto.from, agosto.to)).toBe(true);
  });
});

// Visto en CENTRO: una empleada con finiquito timbrado en julio de 2025 traía
// `fechaBaja` de septiembre de 2026 —la fecha en que alguien actualizó la
// ficha— así que salía «sin recibo timbrado» en todos los meses de en medio.
describe("empleadosConFiniquitoCerrado()", () => {
  const r = (employeeId: string, tipo: string, fecha: string) => ({
    employeeId,
    tipo,
    fechaPago: new Date(`${fecha}T12:00:00Z`),
  });
  const agosto = new Date(2026, 7, 1);

  it("el último recibo es finiquito: ya se fue", () => {
    const fuera = empleadosConFiniquitoCerrado(
      [r("ana", "ORDINARIA", "2025-07-15"), r("ana", "FINIQUITO", "2025-07-16")],
      agosto,
    );
    expect([...fuera]).toEqual(["ana"]);
  });

  // Un recontratado vuelve a contar solo: por eso se mira el ÚLTIMO recibo y no
  // «si alguna vez tuvo finiquito».
  it("recontratado después del finiquito: sigue en nómina", () => {
    const fuera = empleadosConFiniquitoCerrado(
      [r("luis", "FINIQUITO", "2025-07-16"), r("luis", "ORDINARIA", "2026-07-31")],
      agosto,
    );
    expect(fuera.size).toBe(0);
  });

  it("el finiquito del propio mes no lo saca del mes: ahí sí le tocaba recibo", () => {
    const fuera = empleadosConFiniquitoCerrado([r("sara", "FINIQUITO", "2026-08-20")], agosto);
    expect(fuera.size).toBe(0);
  });

  it("sin finiquito, nadie sale", () => {
    expect(empleadosConFiniquitoCerrado([r("ana", "ORDINARIA", "2026-07-31")], agosto).size).toBe(0);
    expect(empleadosConFiniquitoCerrado([], agosto).size).toBe(0);
  });
});
