import { describe, it, expect } from "vitest";
import { reciboCubreElMes } from "./evaluar";

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
